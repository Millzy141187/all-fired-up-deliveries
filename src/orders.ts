import type { D1Database } from "@cloudflare/workers-types";
import {
  DELIVERY_FEE_PENCE,
  deliveryFeeFor,
  getSetting,
  normalisePostcode,
  orderItems,
  orderSummaryShort,
  setSetting,
  type Env,
  type OrderRow,
  type ProductRow,
} from "./db";
import {
  acquireCapacity,
  acquireDayLock,
  acquireSlotLock,
  getSlotState,
  makeOrderLocksPermanent,
  orderHasCapacity,
  orderHasSlotLock,
  releaseOrderLocks,
} from "./availability";
import { zoneForDate, zoneForPostcode } from "./zones";
import {
  clearBusyCache,
  createDeliveryEvent,
  deleteCalendarEvent,
  formatMoney,
  googleConfig,
  GoogleError,
} from "./google";
import {
  createCheckoutSession,
  paymentIntentId,
  retrieveCheckoutSession,
  stripeConfig,
  StripeError,
  type CheckoutSession,
} from "./stripe";
import {
  RESERVATION_MINUTES,
  TRUCK_UNITS_PER_DAY,
  bandById,
  isWeekday,
  meetsNoticeBand,
  todayLondon,
  windowById,
  type DeliveryBandId,
} from "./time";
import { constantTimeEqual, newOrderId, newOrderRef, newToken } from "./crypto";

export class ValidationError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.code = code;
  }
}

export interface CheckoutItemInput {
  id: string;
  qty: number;
}

export interface CheckoutPayload {
  items?: CheckoutItemInput[];
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
    address1?: string;
    address2?: string;
    city?: string;
    postcode?: string;
    notes?: string;
  };
  delivery?: { date?: string; band?: string; windowId?: number };
}

interface LineItem {
  product: ProductRow;
  qty: number;
  linePence: number;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export async function buildReservation(
  env: Env,
  db: D1Database,
  payload: CheckoutPayload,
): Promise<{ order: OrderRow; items: LineItem[] }> {
  const inputItems = Array.isArray(payload.items) ? payload.items : [];
  if (!inputItems.length) throw new ValidationError("Please add at least one product to your order.");

  const desired = new Map<string, number>();
  for (const item of inputItems) {
    if (!item || typeof item.id !== "string") continue;
    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    desired.set(item.id, Math.min(20, (desired.get(item.id) ?? 0) + qty));
  }
  if (!desired.size) throw new ValidationError("Please add at least one product to your order.");

  const ids = [...desired.keys()];
  const rows = await db
    .prepare(`SELECT * FROM products WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<ProductRow>();
  const products = new Map((rows.results ?? []).map((p) => [p.id, p]));

  const lines: LineItem[] = [];
  for (const [id, qty] of desired) {
    const product = products.get(id);
    if (!product) throw new ValidationError("One of the selected products is no longer available.", 409);
    if (qty > product.max_qty) {
      throw new ValidationError(
        `You can order up to ${product.max_qty} × ${product.name} in one order.`,
      );
    }
    lines.push({ product, qty, linePence: product.price_pence * qty });
  }

  const hasFirewood = lines.some((l) =>
    ["Logs", "Loose loads", "Nets"].includes(l.product.category),
  );
  for (const line of lines) {
    if (line.product.requires_firewood && !hasFirewood) {
      throw new ValidationError(`${line.product.name} can only be delivered with a firewood order.`);
    }
  }

  const customer = payload.customer ?? {};
  const name = clean(customer.name, 80);
  const email = clean(customer.email, 120).toLowerCase();
  const phone = clean(customer.phone, 30);
  const address1 = clean(customer.address1, 120);
  const address2 = clean(customer.address2, 120);
  const city = clean(customer.city, 80);
  const postcodeRaw = clean(customer.postcode, 10);
  const notes = clean(customer.notes, 600);

  if (name.length < 2) throw new ValidationError("Please enter the name for the delivery.");
  if (!validEmail(email)) throw new ValidationError("Please enter a valid email address.");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new ValidationError("Please enter a valid phone number.");
  if (address1.length < 3) throw new ValidationError("Please enter the first line of the delivery address.");
  if (city.length < 2) throw new ValidationError("Please enter the town or city.");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i.test(postcodeRaw.replace(/\s+/g, " ").trim())) {
    throw new ValidationError("Please enter a valid UK postcode.");
  }
  const zone = zoneForPostcode(postcodeRaw);
  if (!zone) {
    throw new ValidationError(
      "Sorry, we do not have a regular delivery round for that postcode yet. Please call us and we will see what we can arrange.",
      422,
      "OUT_OF_AREA",
    );
  }
  const postcode = normalisePostcode(postcodeRaw);

  const units = Math.round(lines.reduce((sum, l) => sum + l.product.space_units * l.qty, 0) * 100) / 100;
  if (units > TRUCK_UNITS_PER_DAY) {
    throw new ValidationError(
      `This order needs ${units} of the ${TRUCK_UNITS_PER_DAY} spaces on one truck load. Please reduce a bag or split the order.`,
      400,
      "TRUCK_FULL",
    );
  }

  const date = clean(payload.delivery?.date, 10);
  const rawBand = payload.delivery?.band;
  const legacyWindow = Math.floor(Number(payload.delivery?.windowId));
  const bandId: DeliveryBandId | null =
    rawBand === "morning" || rawBand === "afternoon"
      ? rawBand
      : legacyWindow === 1 || legacyWindow === 2
        ? "morning"
        : legacyWindow === 3 || legacyWindow === 4
          ? "afternoon"
          : null;
  const band = bandId ? bandById(bandId) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("Please choose a delivery date.");
  if (!isWeekday(date)) throw new ValidationError("Deliveries are available Monday to Friday only.", 409);
  if (date < todayLondon()) throw new ValidationError("That delivery date is in the past.", 409);
  const dateZone = zoneForDate(date);
  if (!dateZone) throw new ValidationError("We do not deliver on that day. Please choose another date.", 409);
  if (dateZone.id !== zone.id) {
    throw new ValidationError(
      `We deliver to ${zone.name} on ${zone.dayLabel}s. Please choose a ${zone.dayLabel}.`,
      409,
      "WRONG_ZONE",
    );
  }
  if (!bandId || !band) throw new ValidationError("Please choose morning or afternoon.");
  if (!meetsNoticeBand(date, bandId)) {
    throw new ValidationError(
      "Delivery dates must be at least 24 hours away. Please choose a later date.",
      409,
      "TOO_SOON",
    );
  }

  const slotCheck = await getSlotState(env, db, date, bandId);
  if (!slotCheck.slot || slotCheck.slot.state !== "available") {
    throw new ValidationError(
      slotCheck.slot?.state === "full"
        ? "That day's truck is now full. Please choose another date."
        : "That delivery date is no longer available. Please choose another.",
      409,
      "SLOT_UNAVAILABLE",
    );
  }
  if (slotCheck.day.unitsLeft < units) {
    throw new ValidationError(
      `Only ${slotCheck.day.unitsLeft} of the ${TRUCK_UNITS_PER_DAY} truck spaces are left on that day. Please reduce the order or choose another date.`,
      409,
      "SLOT_UNAVAILABLE",
    );
  }

  const subtotal = lines.reduce((sum, l) => sum + l.linePence, 0);
  const delivery = deliveryFeeFor(subtotal);
  const total = subtotal + delivery;
  const now = Date.now();
  const expiresAt = now + RESERVATION_MINUTES * 60_000;
  const id = newOrderId();
  const ref = newOrderRef();
  const token = newToken();
  const iso = new Date(now).toISOString();

  const order: OrderRow = {
    id,
    ref,
    public_token: token,
    status: "new",
    payment_status: "unpaid",
    customer_name: name,
    email,
    phone,
    address1,
    address2,
    city,
    postcode,
    notes,
    delivery_date: date,
    window_id: 0,
    window_label: band.label,
    band: bandId,
    zone: zone.name,
    space_units: units,
    subtotal_pence: subtotal,
    delivery_pence: delivery,
    total_pence: total,
    stripe_session_id: null,
    stripe_payment_intent: null,
    calendar_event_id: null,
    calendar_event_link: null,
    calendar_error: null,
    reservation_expires_at: expiresAt,
    paid_at: null,
    delivered_at: null,
    created_at: iso,
    updated_at: iso,
    is_sample: 0,
  };

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO orders
         (id, ref, public_token, status, payment_status, customer_name, email, phone, address1, address2, city, postcode, notes,
          delivery_date, window_id, window_label, band, zone, space_units, subtotal_pence, delivery_pence, total_pence, reservation_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'new', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        order.id,
        order.ref,
        order.public_token,
        name,
        email,
        phone,
        address1,
        address2,
        city,
        postcode,
        notes,
        date,
        0,
        band.label,
        bandId,
        zone.name,
        units,
        subtotal,
        delivery,
        total,
        expiresAt,
        iso,
        iso,
      ),
  ];
  for (const line of lines) {
    statements.push(
      db
        .prepare(
          "INSERT INTO order_items (order_id, product_id, name, qty, unit_pence, line_pence) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id, line.product.id, line.product.name, line.qty, line.product.price_pence, line.linePence),
    );
  }
  await db.batch(statements);

  const spaceOk = await acquireCapacity(db, date, units, id, expiresAt);
  if (!spaceOk) {
    await discardReservation(db, id);
    throw new ValidationError("That day's truck has just filled up. Please choose another date.", 409, "SLOT_FULL");
  }

  return { order, items: lines };
}

async function windowCapacity(db: D1Database, date: string, windowId: number): Promise<number> {
  const block = await db
    .prepare("SELECT capacity FROM blocks WHERE date = ? AND window_id = ?")
    .bind(date, windowId)
    .first<{ capacity: number }>();
  if (block) return block.capacity;
  const wholeDay = await db
    .prepare("SELECT capacity FROM blocks WHERE date = ? AND window_id IS NULL")
    .bind(date)
    .first<{ capacity: number }>();
  if (wholeDay) return 0;
  return 2;
}

async function discardReservation(db: D1Database, orderId: string): Promise<void> {
  await releaseOrderLocks(db, orderId);
  await db.batch([
    db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId),
    db.prepare("DELETE FROM orders WHERE id = ?").bind(orderId),
  ]);
}

export async function getOrderById(db: D1Database, id: string): Promise<OrderRow | null> {
  return await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<OrderRow>();
}

export async function getOrderByRef(db: D1Database, ref: string): Promise<OrderRow | null> {
  return await db
    .prepare("SELECT * FROM orders WHERE ref = ?")
    .bind(ref.trim().toUpperCase())
    .first<OrderRow>();
}

export async function getOrderForCustomer(db: D1Database, ref: string, token: string): Promise<OrderRow> {
  const order = await getOrderByRef(db, ref);
  if (!order || !token || !constantTimeEqual(order.public_token, token)) {
    throw new ValidationError("Order not found.", 404);
  }
  return order;
}

export interface PublicOrder {
  ref: string;
  status: string;
  paymentStatus: string;
  customerName: string;
  email: string;
  phone: string;
  address: string;
  postcode: string;
  notes: string;
  deliveryDate: string;
  deliveryWindow: string;
  items: { name: string; qty: number; linePence: number }[];
  subtotal: number;
  delivery: number;
  total: number;
  calendarSynced: boolean;
  calendarError: string | null;
  createdAt: string;
  reservationExpiresAt: number | null;
  isTest: true;
}

export async function toPublicOrder(db: D1Database, order: OrderRow): Promise<PublicOrder> {
  const items = await orderItems(db, order.id);
  return {
    ref: order.ref,
    status: order.status,
    paymentStatus: order.payment_status,
    customerName: order.customer_name,
    email: order.email,
    phone: order.phone,
    address: [order.address1, order.address2, order.city].filter(Boolean).join(", "),
    postcode: order.postcode,
    notes: order.notes,
    deliveryDate: order.delivery_date,
    deliveryWindow: order.window_label,
    items: items.map((i) => ({ name: i.name, qty: i.qty, linePence: i.line_pence })),
    subtotal: order.subtotal_pence,
    delivery: order.delivery_pence,
    total: order.total_pence,
    calendarSynced: Boolean(order.calendar_event_id),
    calendarError: order.calendar_error,
    createdAt: order.created_at,
    reservationExpiresAt: order.reservation_expires_at,
    isTest: true,
  };
}

export async function releaseReservation(
  env: Env,
  db: D1Database,
  ref: string,
  token: string,
): Promise<void> {
  const order = await getOrderForCustomer(db, ref, token);
  if (order.payment_status === "paid") throw new ValidationError("Paid orders cannot be released.", 409);
  await releaseOrderLocks(db, order.id);
  await db
    .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), order.id)
    .run();
}

export async function startCheckout(
  env: Env,
  db: D1Database,
  order: OrderRow,
  origin: string,
): Promise<{ url: string; demo: boolean }> {
  if (order.payment_status === "paid") throw new ValidationError("This order has already been paid.", 409);
  if (order.reservation_expires_at && order.reservation_expires_at <= Date.now()) {
    throw new ValidationError("Your 15-minute slot hold has expired. Please choose a slot again.", 409, "EXPIRED");
  }
  const items = await orderItems(db, order.id);

  const cfg = await stripeConfig(env, db);
  if (cfg.mode === "live") {
    throw new ValidationError(
      "A live Stripe key is configured. This app only accepts Stripe test keys.",
      400,
    );
  }
  if (cfg.mode === "invalid") {
    throw new ValidationError(
      "The saved Stripe key is not a valid test secret key. Update it in Setup.",
      400,
    );
  }

  if (cfg.mode === "test") {
    const success = `${origin}/confirmation?ref=${encodeURIComponent(order.ref)}&token=${order.public_token}&session_id={CHECKOUT_SESSION_ID}`;
    const cancel = `${origin}/?canceled=1&ref=${encodeURIComponent(order.ref)}#review`;
    const session = await createCheckoutSession(
      env,
      db,
      order,
      items.map((i) => ({ name: i.name, qty: i.qty, unit_pence: i.unit_pence })),
      { success, cancel },
    );
    await db
      .prepare("UPDATE orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?")
      .bind(session.id, new Date().toISOString(), order.id)
      .run();
    return { url: session.url, demo: false };
  }

  return {
    url: `/demo-pay?ref=${encodeURIComponent(order.ref)}&token=${order.public_token}`,
    demo: true,
  };
}

export async function finalizePaidOrder(
  env: Env,
  db: D1Database,
  orderId: string,
  opts: { sessionId?: string; paymentIntent?: string; demo?: boolean },
): Promise<OrderRow> {
  let order = await getOrderById(db, orderId);
  if (!order) throw new ValidationError("Order not found.", 404);
  if (order.payment_status === "paid") return order;

  const items = await orderItems(db, order.id);
  const nowIso = new Date().toISOString();
  let calendarError: string | null = null;

  if (order.band) {
    if (!(await orderHasCapacity(db, order.id))) {
      const spaceOk = await acquireCapacity(
        db,
        order.delivery_date,
        order.space_units || 0,
        order.id,
        null,
      );
      if (!spaceOk) {
        calendarError =
          "Payment received after the truck space hold expired and the day was full. The order needs manual attention.";
      }
    }
  } else if (!(await orderHasSlotLock(db, order.id))) {
    const win = windowById(order.window_id);
    const dayOk = await acquireDayLock(db, order.delivery_date, order.id, null, Date.now());
    const slotOk = win
      ? await acquireSlotLock(
          db,
          order.delivery_date,
          order.window_id,
          await windowCapacity(db, order.delivery_date, order.window_id),
          order.id,
          null,
          Date.now(),
        )
      : false;
    if (!dayOk || !slotOk) {
      calendarError =
        "Payment received after the slot hold expired and the slot was no longer free. The order needs manual attention.";
    }
  }
  await makeOrderLocksPermanent(db, order.id);

  const paidUpdate = await db
    .prepare(
      `UPDATE orders SET payment_status = 'paid', status = CASE WHEN status IN ('cancelled','refunded') THEN status ELSE 'new' END,
        paid_at = COALESCE(paid_at, ?), reservation_expires_at = NULL, updated_at = ?,
        stripe_session_id = COALESCE(?, stripe_session_id),
        stripe_payment_intent = COALESCE(?, stripe_payment_intent)
       WHERE id = ? AND payment_status != 'paid'`,
    )
    .bind(nowIso, nowIso, opts.sessionId ?? null, opts.paymentIntent ?? null, order.id)
    .run();
  if ((paidUpdate.meta.changes ?? 0) === 0) {
    return (await getOrderById(db, order.id))!;
  }
  order = (await getOrderById(db, order.id))!;

  if (order.calendar_event_id) return order;

  if (calendarError) {
    await db.prepare("UPDATE orders SET calendar_error = ? WHERE id = ?").bind(calendarError, order.id).run();
    return (await getOrderById(db, order.id))!;
  }

  try {
    const cfg = await googleConfig(env, db);
    if (!cfg.refreshToken) {
      throw new GoogleError("Google Calendar is not connected yet.", 400);
    }
    const summary = orderSummaryShort(items.map((i) => ({ name: i.name, qty: i.qty })));
    const event = await createDeliveryEvent(env, db, order, items, summary);
    await db
      .prepare(
        "UPDATE orders SET calendar_event_id = ?, calendar_event_link = ?, calendar_error = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(event.id, event.link || null, new Date().toISOString(), order.id)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Calendar event could not be created.";
    await db
      .prepare("UPDATE orders SET calendar_error = ?, updated_at = ? WHERE id = ?")
      .bind(message, new Date().toISOString(), order.id)
      .run();
  }

  return (await getOrderById(db, order.id))!;
}

export async function syncOrderFromStripe(
  env: Env,
  db: D1Database,
  order: OrderRow,
  sessionId?: string,
): Promise<OrderRow> {
  if (order.payment_status === "paid") return order;
  const id = sessionId || order.stripe_session_id || "";
  if (!id) return order;
  const cfg = await stripeConfig(env, db);
  if (!cfg.configured) return order;
  const session = await retrieveCheckoutSession(env, db, id);
  if (session.metadata?.order_id && session.metadata.order_id !== order.id) {
    throw new StripeError("This payment does not belong to the order.", 400);
  }
  if (session.payment_status !== "paid") return order;
  if (typeof session.amount_total === "number" && session.amount_total !== order.total_pence) {
    throw new StripeError("The paid amount does not match this order. Please contact us.", 409);
  }
  return finalizePaidOrder(env, db, order.id, {
    sessionId: session.id,
    paymentIntent: paymentIntentId(session),
  });
}

export async function handleStripeEvent(
  env: Env,
  db: D1Database,
  eventType: string,
  session: CheckoutSession,
): Promise<void> {
  const orderId = session.metadata?.order_id;
  if (!orderId) return;
  const order = await getOrderById(db, orderId);
  if (!order) return;

  if (eventType === "checkout.session.expired") {
    if (order.payment_status !== "paid") {
      await releaseOrderLocks(db, order.id);
      await db
        .prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), order.id)
        .run();
    }
    return;
  }

  if (
    (eventType === "checkout.session.completed" ||
      eventType === "checkout.session.async_payment_succeeded") &&
    session.payment_status === "paid"
  ) {
    if (typeof session.amount_total === "number" && session.amount_total !== order.total_pence) return;
    await finalizePaidOrder(env, db, order.id, {
      sessionId: session.id,
      paymentIntent: paymentIntentId(session),
    });
  }
}

export async function changeOrderStatus(
  env: Env,
  db: D1Database,
  order: OrderRow,
  status: string,
): Promise<{ order: OrderRow; calendarWarning?: string }> {
  const allowed = ["new", "confirmed", "out_for_delivery", "delivered", "cancelled", "refunded"];
  if (!allowed.includes(status)) throw new ValidationError("Unknown order status.");

  let calendarWarning: string | undefined;
  if ((status === "cancelled" || status === "refunded") && order.calendar_event_id) {
    try {
      await deleteCalendarEvent(env, db, order.calendar_event_id);
    } catch (err) {
      calendarWarning =
        err instanceof Error
          ? `Order updated, but the calendar event could not be removed: ${err.message}`
          : "Order updated, but the calendar event could not be removed.";
    }
  }

  if (status === "cancelled" || status === "refunded") {
    await releaseOrderLocks(db, order.id);
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `UPDATE orders SET status = ?, payment_status = CASE WHEN ? = 'refunded' THEN 'refunded' ELSE payment_status END,
        delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
        calendar_event_id = CASE WHEN ? IN ('cancelled','refunded') THEN NULL ELSE calendar_event_id END,
        calendar_event_link = CASE WHEN ? IN ('cancelled','refunded') THEN NULL ELSE calendar_event_link END,
        updated_at = ? WHERE id = ?`,
    )
    .bind(status, status, status, nowIso, status, status, nowIso, order.id)
    .run();

  return { order: (await getOrderById(db, order.id))!, calendarWarning };
}

export async function retryCalendarForOrder(
  env: Env,
  db: D1Database,
  order: OrderRow,
): Promise<OrderRow> {
  if (order.payment_status !== "paid") throw new ValidationError("Only paid orders can be added to the calendar.");
  if (order.calendar_event_id) return order;
  const items = await orderItems(db, order.id);
  const summary = orderSummaryShort(items.map((i) => ({ name: i.name, qty: i.qty })));
  const event = await createDeliveryEvent(env, db, order, items, summary);
  await db
    .prepare(
      "UPDATE orders SET calendar_event_id = ?, calendar_event_link = ?, calendar_error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(event.id, event.link || null, new Date().toISOString(), order.id)
    .run();
  return (await getOrderById(db, order.id))!;
}

export async function saveStripeSettings(
  env: Env,
  db: D1Database,
  input: { secretKey?: string; webhookSecret?: string },
): Promise<void> {
  const key = clean(input.secretKey, 200);
  if (key) {
    if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
      throw new ValidationError(
        "Live Stripe keys are blocked. Enter a test-mode secret key beginning sk_test_.",
        400,
      );
    }
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new ValidationError("That does not look like a Stripe test secret key (sk_test_…).");
    }
    await setSetting(db, "stripe_secret_key", key);
  }
  const webhook = clean(input.webhookSecret, 200);
  if (webhook) {
    if (!webhook.startsWith("whsec_")) {
      throw new ValidationError("That does not look like a Stripe webhook signing secret (whsec_…).");
    }
    await setSetting(db, "stripe_webhook_secret", webhook);
  }
}

export function money(pence: number): string {
  return formatMoney(pence);
}

export { DELIVERY_FEE_PENCE, clearBusyCache };
