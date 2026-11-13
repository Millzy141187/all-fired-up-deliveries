import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  BUSINESS,
  DELIVERY_FEE_PENCE,
  FREE_DELIVERY_THRESHOLD_PENCE,
  ORDER_STATUSES,
  cleanupExpiredReservations,
  ensureDb,
  getSetting,
  getSettings,
  orderEmails,
  orderItems,
  setSetting,
  type BlockRow,
  type OrderEmailRow,
  type Env,
  type OrderRow,
  type ProductRow,
} from "./db";
import { clearAdminSession, isAdmin, issueAdminSession } from "./auth";
import { newToken, randomHex, hashPassword, verifyPassword } from "./crypto";
import {
  adminCalendarMonth,
  computeAvailability,
  getSlotState,
  releaseOrderLocks,
} from "./availability";
import {
  buildReservation,
  changeOrderStatus,
  getOrderByRef,
  getOrderForCustomer,
  getOrderById,
  releaseReservation,
  retryCalendarForOrder,
  saveStripeSettings,
  startCheckout,
  syncOrderFromStripe,
  toPublicOrder,
  finalizePaidOrder,
  handleStripeEvent,
  ValidationError,
} from "./orders";
import {
  GoogleError,
  clearBusyCache,
  createBlockEvent,
  deleteCalendarEvent,
  exchangeGoogleCode,
  formatMoney,
  GMAIL_SEND_SCOPE,
  getCalendar,
  googleAuthUrl,
  googleConfig,
  listGoogleCalendars,
  sendCustomerEmail,
  redirectUri,
  resolveDeliveryCalendar,
  testCalendarAccess,
} from "./google";
import {
  retrieveCheckoutSession,
  stripeConfig,
  StripeError,
  verifyStripeWebhook,
  type CheckoutSession,
} from "./stripe";
import { TRUCK_UNITS_PER_DAY, addDays, formatLongDate, todayLondon, windowById } from "./time";
import { DELIVERY_ZONES } from "./zones";
import {
  maybeSendMorningReminders,
  remindersOverview,
  sendDeliveryReminders,
} from "./reminders";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await ensureDb(c.env.DB);
  // Automatic morning reminders ride on ordinary traffic: Sites has no cron
  // trigger, so the first request after 07:30 London runs them. It is
  // idempotent, and a failure must never break the request.
  if (c.req.method === "GET") {
    c.executionCtx.waitUntil(
      maybeSendMorningReminders(c.env).catch(() => {
        // Reminders are best-effort.
      }),
    );
  }
  await next();
});

const VERCEL_ORIGIN = "https://all-fired-up-deliveries.vercel.app";
const LOCAL_ORIGINS = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

function requestOrigin(c: any): string {
  return new URL(c.req.url).origin;
}

function normaliseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function allowedOrigin(c: any, value: string | null | undefined): string | null {
  const origin = normaliseOrigin(value);
  if (!origin) return null;
  return origin === VERCEL_ORIGIN || origin === requestOrigin(c) || LOCAL_ORIGINS.has(origin)
    ? origin
    : null;
}

/**
 * The customer site can be served from Vercel while the API stays on
 * Cloudflare. Only trust origins we explicitly recognise; never build a
 * redirect URL from an arbitrary caller-supplied value.
 */
function publicOrigin(c: any): string {
  if (c.env.APP_URL) return String(c.env.APP_URL).replace(/\/$/, "");
  const forwardedHost = c.req.header("x-forwarded-host");
  const candidates = [
    c.req.query("origin"),
    c.req.query("publicOrigin"),
    c.req.header("origin"),
    c.req.header("referer"),
    forwardedHost
      ? (forwardedHost.includes("://") ? forwardedHost : `https://${forwardedHost}`)
      : null,
  ];
  for (const candidate of candidates) {
    const origin = allowedOrigin(c, candidate);
    if (origin) return origin;
  }
  return requestOrigin(c);
}

app.use("/api/admin/*", async (c, next) => {
  if (["POST", "PATCH", "DELETE", "PUT"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin) {
      try {
        const parsed = new URL(origin).origin;
        if (parsed !== requestOrigin(c) && parsed !== VERCEL_ORIGIN && !LOCAL_ORIGINS.has(parsed)) {
          return c.json({ error: "Cross-origin request blocked." }, 403);
        }
      } catch {
        return c.json({ error: "Cross-origin request blocked." }, 403);
      }
    }
  }
  await next();
});

async function serveAsset(c: any, path: string): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  url.search = "";
  return c.env.ASSETS.fetch(
    new Request(url.toString(), { method: "GET", headers: c.req.raw.headers }),
  );
}

function jsonError(err: unknown) {
  if (err instanceof ValidationError) {
    return { body: { error: err.message, code: err.code }, status: err.status as any };
  }
  if (err instanceof GoogleError) {
    return { body: { error: err.message, google: true }, status: (err.status >= 400 && err.status < 600 ? err.status : 500) as any };
  }
  if (err instanceof StripeError) {
    return { body: { error: err.message, stripe: true }, status: (err.status >= 400 && err.status < 600 ? err.status : 502) as any };
  }
  console.error(err);
  return { body: { error: "Something went wrong. Please try again." }, status: 500 as any };
}

app.onError((err, c) => {
  const { body, status } = jsonError(err);
  return c.json(body, status);
});

/* ------------------------------------------------------------------ */
/* Public catalogue and availability                                   */
/* ------------------------------------------------------------------ */

app.get("/api/health", (c) => c.json({ ok: true, app: "All Fired Up test ordering" }));

app.get("/api/bootstrap", async (c) => {
  const [productRes, settings, stripe] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM products WHERE active = 1 ORDER BY sort ASC").all<ProductRow>(),
    getSettings(c.env.DB, [
      "google_refresh_token",
      "google_calendar_name",
      "stripe_secret_key",
      "admin_password_default",
    ]),
    stripeConfig(c.env, c.env.DB),
  ]);

  const products = (productRes.results ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: p.subtitle,
    description: p.description,
    price: p.price_pence,
    unit: p.unit,
    category: p.category,
    image: p.image,
    maxQty: p.max_qty,
    spaceUnits: p.space_units,
    addonOnly: Boolean(p.addon_only),
    requiresFirewood: Boolean(p.requires_firewood),
    note: p.note,
  }));

  return c.json({
    business: {
      name: BUSINESS.name,
      tagline: BUSINESS.tagline,
      phone: BUSINESS.phone,
      email: BUSINESS.email,
      address: BUSINESS.address,
      radiusMiles: BUSINESS.radiusMiles,
      postcodePrefixes: BUSINESS.deliveryPrefixes,
      zones: DELIVERY_ZONES.map((zone) => ({
        id: zone.id,
        name: zone.name,
        dayLabel: zone.dayLabel,
        districts: zone.districts,
      })),
      calendarName: settings.google_calendar_name || BUSINESS.defaultCalendarName,
    },
    products,
    delivery: {
      feePence: DELIVERY_FEE_PENCE,
      freeOverPence: FREE_DELIVERY_THRESHOLD_PENCE,
      truckUnits: TRUCK_UNITS_PER_DAY,
    },
    stripe: {
      mode: stripe.mode,
      configured: stripe.configured,
      webhookConfigured: stripe.webhookConfigured,
      testMode: true,
    },
    calendar: {
      connected: Boolean(settings.google_refresh_token),
      name: settings.google_calendar_name || BUSINESS.defaultCalendarName,
    },
    demoPassword:
      settings.admin_password_default === "1" && !c.env.ADMIN_PASSWORD ? "firewood2026" : null,
    today: todayLondon(),
  });
});

app.get("/api/availability", async (c) => {
  const days = Math.min(60, Math.max(7, Number(c.req.query("days") || 35)));
  const result = await computeAvailability(c.env, c.env.DB, { days });
  return c.json(result);
});

/* ------------------------------------------------------------------ */
/* Customer orders                                                     */
/* ------------------------------------------------------------------ */

app.post("/api/reservations", async (c) => {
  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") throw new ValidationError("Invalid order details.");
  const { order } = await buildReservation(c.env, c.env.DB, payload);
  const publicOrder = await toPublicOrder(c.env.DB, order);
  return c.json(
    {
      ref: order.ref,
      token: order.public_token,
      expiresAt: order.reservation_expires_at,
      order: publicOrder,
    },
    201,
  );
});

app.post("/api/reservations/release", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await releaseReservation(c.env, c.env.DB, String(body.ref || ""), String(body.token || ""));
  return c.json({ ok: true });
});

app.post("/api/checkout/session", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const order = await getOrderForCustomer(c.env.DB, String(body.ref || ""), String(body.token || ""));
  const returnOrigin = allowedOrigin(c, typeof body.returnOrigin === "string" ? body.returnOrigin : "");
  const result = await startCheckout(c.env, c.env.DB, order, returnOrigin || publicOrigin(c));
  return c.json(result);
});

app.post("/api/demo/confirm", async (c) => {
  const cfg = await stripeConfig(c.env, c.env.DB);
  if (cfg.mode !== "none") {
    throw new ValidationError("Stripe is configured — use the card payment flow.", 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const order = await getOrderForCustomer(c.env.DB, String(body.ref || ""), String(body.token || ""));
  if (order.reservation_expires_at && order.reservation_expires_at <= Date.now()) {
    throw new ValidationError("The slot hold expired before payment. Please choose a slot again.", 409);
  }
  await finalizePaidOrder(c.env, c.env.DB, order.id, { demo: true });
  const updated = await getOrderById(c.env.DB, order.id);
  return c.json({ ok: true, order: await toPublicOrder(c.env.DB, updated!) });
});

app.get("/api/orders/:ref", async (c) => {
  const order = await getOrderForCustomer(
    c.env.DB,
    c.req.param("ref"),
    c.req.query("token") || "",
  );
  return c.json({ order: await toPublicOrder(c.env.DB, order) });
});

app.post("/api/orders/:ref/sync", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const order = await getOrderForCustomer(c.env.DB, c.req.param("ref"), String(body.token || ""));
  if (order.payment_status !== "paid") {
    const cfg = await stripeConfig(c.env, c.env.DB);
    if (cfg.configured) {
      const sessionId = String(body.session_id || "") || order.stripe_session_id || "";
      if (sessionId) {
        await syncOrderFromStripe(c.env, c.env.DB, order, sessionId);
      }
    }
  }
  const latest = (await getOrderById(c.env.DB, order.id))!;
  return c.json({ order: await toPublicOrder(c.env.DB, latest) });
});

app.post("/api/stripe/webhook", async (c) => {
  const cfg = await stripeConfig(c.env, c.env.DB);
  if (!cfg.webhookSecret) {
    return c.json({ error: "Stripe webhook secret is not configured." }, 503);
  }
  const payload = await c.req.text();
  const signature = c.req.header("stripe-signature") || "";
  if (!(await verifyStripeWebhook(payload, signature, cfg.webhookSecret))) {
    return c.json({ error: "Invalid Stripe signature." }, 400);
  }

  let event: { id?: string; type?: string; data?: { object?: CheckoutSession } };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json({ error: "Invalid payload." }, 400);
  }
  if (!event.id || !event.type) return c.json({ error: "Invalid event." }, 400);

  const alreadySeen = await c.env.DB.prepare("SELECT 1 AS x FROM webhook_events WHERE id = ?")
    .bind(event.id)
    .first();
  if (alreadySeen) return c.json({ received: true });

  try {
    if (event.type.startsWith("checkout.session.") && event.data?.object) {
      await handleStripeEvent(c.env, c.env.DB, event.type, event.data.object);
    }
    // Only mark the event handled once processing completes, so Stripe can retry
    // after a transient database or Google Calendar failure.
    await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, created_at) VALUES (?, ?)")
      .bind(event.id, new Date().toISOString())
      .run();
  } catch (err) {
    console.error("Stripe webhook handling failed", err);
    return c.json({ error: "Webhook processing failed; please retry." }, 500);
  }
  return c.json({ received: true });
});

/* ------------------------------------------------------------------ */
/* Admin authentication                                                */
/* ------------------------------------------------------------------ */

const loginAttempts = new Map<string, { count: number; first: number }>();

app.post("/api/admin/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || "local";
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && now - record.first < 15 * 60_000 && record.count >= 8) {
    return c.json({ error: "Too many attempts. Please wait 15 minutes." }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password || "");
  let ok = false;
  if (c.env.ADMIN_PASSWORD) {
    ok = password === c.env.ADMIN_PASSWORD;
  } else {
    const stored = await getSetting(c.env.DB, "admin_password_hash");
    ok = stored ? await verifyPassword(password, stored) : false;
  }
  if (!ok) {
    loginAttempts.set(ip, record && now - record.first < 15 * 60_000 ? { ...record, count: record.count + 1 } : { count: 1, first: now });
    return c.json({ error: "That password is not correct." }, 401);
  }
  loginAttempts.delete(ip);
  await issueAdminSession(c);
  return c.json({ ok: true });
});

app.post("/api/admin/logout", async (c) => {
  await clearAdminSession(c);
  return c.json({ ok: true });
});

const adminApi = new Hono<{ Bindings: Env }>();
adminApi.use("*", async (c, next) => {
  // Login lives on the parent app; do not let the admin guard swallow it.
  if (c.req.path === "/api/admin/login" || c.req.path === "/api/admin/logout") return next();
  if (!(await isAdmin(c))) return c.json({ error: "Please sign in." }, 401);
  await next();
});

adminApi.get("/session", async (c) => {
  const usingDefault = (await getSetting(c.env.DB, "admin_password_default")) === "1";
  return c.json({ ok: true, usingDefaultPassword: usingDefault && !c.env.ADMIN_PASSWORD });
});

adminApi.get("/stats", async (c) => {
  const today = todayLondon();
  const calendarConnected = Boolean(await getSetting(c.env.DB, "google_refresh_token"));
  const [upcoming, todays, revenue, issues] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'paid' AND status NOT IN ('delivered','cancelled','refunded','expired') AND delivery_date >= ?",
    )
      .bind(today)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE delivery_date = ? AND status NOT IN ('cancelled','expired','refunded')",
    )
      .bind(today)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(total_pence),0) AS n FROM orders WHERE payment_status = 'paid' AND status NOT IN ('cancelled','refunded','expired') AND delivery_date >= ?",
    )
      .bind(today)
      .first<{ n: number }>(),
    calendarConnected
      ? c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM orders WHERE payment_status = 'paid' AND is_sample = 0 AND calendar_event_id IS NULL AND status NOT IN ('cancelled','refunded','expired')",
        ).first<{ n: number }>()
      : Promise.resolve({ n: 0 }),
  ]);
  return c.json({
    upcomingOrders: upcoming?.n ?? 0,
    todayOrders: todays?.n ?? 0,
    upcomingValue: revenue?.n ?? 0,
    calendarIssues: issues?.n ?? 0,
    calendarConnected,
  });
});

adminApi.get("/reminders", async (c) => c.json(await remindersOverview(c.env)));

adminApi.post("/reminders/run", async (c) => {
  const result = await sendDeliveryReminders(c.env, todayLondon(), { retryFailed: true });
  return c.json(result);
});

adminApi.get("/orders", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const status = c.req.query("status") || "";
  const date = c.req.query("date") || "";
  const conditions = ["o.status NOT IN ('expired','abandoned')"];
  const params: unknown[] = [];
  if (status && ORDER_STATUSES.includes(status as any)) {
    conditions.push("o.status = ?");
    params.push(status);
  }
  if (date) {
    conditions.push("o.delivery_date = ?");
    params.push(date);
  }
  if (q) {
    const like = `%${q}%`;
    conditions.push(
      "(o.ref LIKE ? OR o.customer_name LIKE ? OR o.postcode LIKE ? OR o.email LIKE ? OR o.phone LIKE ? OR o.delivery_date = ?)",
    );
    params.push(like, like, like, like, like, q);
  }
  const sql = `SELECT o.*, (SELECT GROUP_CONCAT(i.name || ' ×' || i.qty, ', ') FROM order_items i WHERE i.order_id = o.id) AS items_summary
    FROM orders o WHERE ${conditions.join(" AND ")}
    ORDER BY o.delivery_date ASC, CASE o.band WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE o.window_id END, o.created_at LIMIT 250`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<OrderRow & { items_summary: string }>();
  return c.json({
    orders: (rows.results ?? []).map((o) => {
      const { public_token, ...safe } = o;
      return {
        ...safe,
        itemsSummary: o.items_summary,
        totalLabel: formatMoney(o.total_pence),
      };
    }),
  });
});

adminApi.get("/orders/:id", async (c) => {
  const order = await getOrderById(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "Order not found." }, 404);
  const [items, emails, emailSettings, history, calendarName] = await Promise.all([
    orderItems(c.env.DB, order.id),
    orderEmails(c.env.DB, order.id),
    getSettings(c.env.DB, ["google_refresh_token", "google_account_email", "google_scopes"]),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(delivery_date) AS last FROM orders WHERE email = ? AND id != ? AND payment_status = 'paid'",
    )
      .bind(order.email, order.id)
      .first<{ n: number; last: string | null }>(),
    getSetting(c.env.DB, "google_calendar_name"),
  ]);
  const granted = (emailSettings.google_scopes || "").split(/\s+/);
  return c.json({
    order: { ...order, totalLabel: formatMoney(order.total_pence) },
    items,
    emails,
    calendarName: calendarName || BUSINESS.defaultCalendarName,
    email: {
      connected: Boolean(emailSettings.google_refresh_token),
      ready:
        Boolean(emailSettings.google_refresh_token) && granted.includes(GMAIL_SEND_SCOPE),
      from: emailSettings.google_account_email || "",
    },
    customerHistory: { paidOrders: history?.n ?? 0, lastDelivery: history?.last ?? null },
  });
});

adminApi.patch("/orders/:id", async (c) => {
  const order = await getOrderById(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "Order not found." }, 404);
  const body = await c.req.json().catch(() => ({}));
  const result = await changeOrderStatus(c.env, c.env.DB, order, String(body.status || ""));
  return c.json({ order: result.order, warning: result.calendarWarning });
});

adminApi.post("/orders/:id/email", async (c) => {
  const order = await getOrderById(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "Order not found." }, 404);
  if (!order.email) throw new ValidationError("This order does not have a customer email address.");
  const body = await c.req.json().catch(() => ({}));
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 160) : "";
  const message = typeof body.body === "string" ? body.body.trim().slice(0, 6000) : "";
  if (subject.length < 3) throw new ValidationError("Add a subject line.");
  if (message.length < 5) throw new ValidationError("Write a message before sending.");

  const sent = await sendCustomerEmail(c.env, c.env.DB, {
    to: order.email,
    subject,
    text: message,
  });
  const email: OrderEmailRow = {
    id: crypto.randomUUID(),
    order_id: order.id,
    to_email: order.email,
    subject,
    body: message,
    gmail_id: sent.id,
    sent_at: new Date().toISOString(),
  };
  await c.env.DB.prepare(
    "INSERT INTO order_emails (id, order_id, to_email, subject, body, gmail_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(email.id, email.order_id, email.to_email, email.subject, email.body, email.gmail_id, email.sent_at)
    .run();
  return c.json({ ok: true, email, from: sent.from }, 201);
});

adminApi.post("/orders/:id/calendar", async (c) => {
  const order = await getOrderById(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "Order not found." }, 404);
  const updated = await retryCalendarForOrder(c.env, c.env.DB, order);
  return c.json({ order: updated });
});

adminApi.get("/schedule", async (c) => {
  const date = c.req.query("date") || todayLondon();
  const orders = await c.env.DB.prepare(
    `SELECT o.*, (SELECT GROUP_CONCAT(i.name || ' ×' || i.qty, ', ') FROM order_items i WHERE i.order_id = o.id) AS items_summary
     FROM orders o WHERE o.delivery_date = ? AND o.status NOT IN ('expired','abandoned') ORDER BY CASE o.band WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE o.window_id END, o.created_at`,
  )
    .bind(date)
    .all<OrderRow & { items_summary: string }>();
  const blocks = await c.env.DB.prepare("SELECT * FROM blocks WHERE date = ? ORDER BY band, window_id").bind(date).all<BlockRow>();
  const availability = await computeAvailability(c.env, c.env.DB, {
    from: date,
    days: 1,
    includePast: true,
    includeNotes: true,
  });
  return c.json({
    date,
    label: formatLongDate(date),
    orders: (orders.results ?? []).map((o) => ({ ...o, itemsSummary: o.items_summary })),
    blocks: blocks.results ?? [],
    day: availability.days[0] ?? null,
    calendar: availability.calendar,
  });
});

adminApi.get("/calendar", async (c) => {
  const month = /^\d{4}-\d{2}$/.test(c.req.query("month") || "")
    ? c.req.query("month")!
    : todayLondon().slice(0, 7);
  const [orders, blocks] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM orders WHERE delivery_date LIKE ? AND status NOT IN ('expired','abandoned') ORDER BY delivery_date, band, window_id",
    )
      .bind(`${month}-%`)
      .all<OrderRow>(),
    c.env.DB.prepare("SELECT * FROM blocks WHERE date LIKE ?").bind(`${month}-%`).all<BlockRow>(),
  ]);
  return c.json({
    ...adminCalendarMonth(month, orders.results ?? [], blocks.results ?? []),
    orders: orders.results ?? [],
    blocks: blocks.results ?? [],
  });
});

adminApi.get("/availability", async (c) => {
  const from = c.req.query("from") || todayLondon();
  const days = Math.min(90, Math.max(7, Number(c.req.query("days") || 56)));
  return c.json(await computeAvailability(c.env, c.env.DB, { from, days, includePast: true, includeNotes: true }));
});

adminApi.get("/blocks", async (c) => {
  const from = c.req.query("from") || todayLondon();
  const to = c.req.query("to") || addDays(from, 90);
  const rows = await c.env.DB.prepare("SELECT * FROM blocks WHERE date >= ? AND date <= ? ORDER BY date, band, window_id")
    .bind(from, to)
    .all<BlockRow>();
  return c.json({ blocks: rows.results ?? [] });
});

adminApi.post("/blocks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("Choose a valid date.");
  const bandRaw = body.band;
  const band = bandRaw === "morning" || bandRaw === "afternoon" ? bandRaw : "";
  if (bandRaw && !band) throw new ValidationError("Choose morning or afternoon.");
  const legacyWindow =
    body.windowId === null || body.windowId === undefined || body.windowId === ""
      ? null
      : Number(body.windowId);
  if (legacyWindow !== null && !windowById(legacyWindow)) {
    throw new ValidationError("Choose a valid delivery window.");
  }
  const wholeDay = !band && legacyWindow === null;
  const capacity = band ? 0 : wholeDay ? 0 : Number(body.capacity);
  if (![0, 1, 2].includes(capacity)) throw new ValidationError("Capacity must be 0, 1 or 2.");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";

  const paid = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE delivery_date = ? AND payment_status = 'paid' AND status NOT IN ('cancelled','refunded','expired')",
  )
    .bind(date)
    .first<{ n: number }>();
  const paidOrders = paid?.n ?? 0;
  if (paidOrders > 0 && body.acknowledge !== true) {
    return c.json(
      {
        error: `This day has ${paidOrders} paid ${paidOrders === 1 ? "order" : "orders"}. Please contact customers to rearrange.`,
        warning: `This day has ${paidOrders} paid ${paidOrders === 1 ? "order" : "orders"}. Please contact customers to rearrange.`,
        paidOrders,
        requiresAcknowledgement: true,
      },
      409,
    );
  }

  if (wholeDay) {
    const existing = await c.env.DB.prepare("SELECT * FROM blocks WHERE date = ?").bind(date).all<BlockRow>();
    for (const old of existing.results ?? []) {
      if (old.calendar_event_id) {
        try {
          await deleteCalendarEvent(c.env, c.env.DB, old.calendar_event_id);
        } catch {
          // Keep going: the local block still applies.
        }
      }
    }
    await c.env.DB.prepare("DELETE FROM blocks WHERE date = ?").bind(date).run();
  } else if (band) {
    const legacyIds = band === "morning" ? [1, 2] : [3, 4];
    const existing = await c.env.DB.prepare(
      "SELECT * FROM blocks WHERE date = ? AND (band = ? OR window_id IN (?, ?))",
    )
      .bind(date, band, legacyIds[0], legacyIds[1])
      .all<BlockRow>();
    for (const old of existing.results ?? []) {
      if (old.calendar_event_id) {
        try {
          await deleteCalendarEvent(c.env, c.env.DB, old.calendar_event_id);
        } catch {
          // The database block still applies even if the calendar event could not be removed.
        }
      }
    }
    await c.env.DB.prepare("DELETE FROM blocks WHERE date = ? AND (band = ? OR window_id IN (?, ?))")
      .bind(date, band, legacyIds[0], legacyIds[1])
      .run();
  } else {
    const existing = await c.env.DB.prepare("SELECT * FROM blocks WHERE date = ? AND window_id = ?")
      .bind(date, legacyWindow)
      .first<BlockRow>();
    if (existing?.calendar_event_id) {
      try {
        await deleteCalendarEvent(c.env, c.env.DB, existing.calendar_event_id);
      } catch {
        // The database block still applies even if the calendar event could not be removed.
      }
    }
    await c.env.DB.prepare("DELETE FROM blocks WHERE date = ? AND window_id = ?")
      .bind(date, legacyWindow)
      .run();
  }

  const block: BlockRow = {
    id: crypto.randomUUID(),
    date,
    window_id: wholeDay ? null : legacyWindow,
    band,
    capacity,
    note,
    calendar_event_id: null,
    created_at: new Date().toISOString(),
  };
  await c.env.DB.prepare(
    "INSERT INTO blocks (id, date, window_id, band, capacity, note, calendar_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
  )
    .bind(block.id, block.date, block.window_id, block.band, block.capacity, block.note, block.created_at)
    .run();

  let calendarWarning: string | undefined;
  if (capacity === 0) {
    const cfg = await googleConfig(c.env, c.env.DB);
    if (cfg.refreshToken) {
      try {
        const event = await createBlockEvent(c.env, c.env.DB, block);
        block.calendar_event_id = event.id;
        await c.env.DB.prepare("UPDATE blocks SET calendar_event_id = ? WHERE id = ?")
          .bind(event.id, block.id)
          .run();
      } catch (err) {
        calendarWarning =
          err instanceof Error
            ? `Blocked in the app, but the Google Calendar event could not be created: ${err.message}`
            : "Blocked in the app, but the Google Calendar event could not be created.";
      }
    }
  }

  return c.json({ block, paidOrders, warning: calendarWarning }, 201);
});

adminApi.delete("/blocks/:id", async (c) => {
  const block = await c.env.DB.prepare("SELECT * FROM blocks WHERE id = ?").bind(c.req.param("id")).first<BlockRow>();
  if (!block) return c.json({ error: "Block not found." }, 404);
  let warning: string | undefined;
  if (block.calendar_event_id) {
    try {
      await deleteCalendarEvent(c.env, c.env.DB, block.calendar_event_id);
    } catch (err) {
      warning = err instanceof Error ? err.message : "Could not remove the calendar event.";
    }
  }
  await c.env.DB.prepare("DELETE FROM blocks WHERE id = ?").bind(block.id).run();
  return c.json({ ok: true, warning });
});

adminApi.get("/settings", async (c) => {
  const [settings, stripe] = await Promise.all([
    getSettings(c.env.DB, [
      "google_client_id",
      "google_refresh_token",
      "google_calendar_id",
      "google_calendar_name",
      "google_account_email",
      "google_scopes",
      "stripe_secret_key",
      "stripe_webhook_secret",
      "admin_password_default",
    ]),
    stripeConfig(c.env, c.env.DB),
  ]);
  return c.json({
    google: {
      connected: Boolean(settings.google_refresh_token),
      clientConfigured: Boolean(settings.google_client_id || c.env.GOOGLE_CLIENT_ID),
      clientId: settings.google_client_id || c.env.GOOGLE_CLIENT_ID ? "configured" : "",
      accountEmail: settings.google_account_email || "",
      emailReady:
        Boolean(settings.google_refresh_token) &&
        (settings.google_scopes || "").split(/\s+/).includes(GMAIL_SEND_SCOPE),
      calendarId: settings.google_calendar_id || "",
      calendarName: settings.google_calendar_name || BUSINESS.defaultCalendarName,
      redirectUri: redirectUri(publicOrigin(c)),
    },
    stripe: {
      mode: stripe.mode,
      configured: stripe.configured,
      webhookConfigured: stripe.webhookConfigured,
      keyTail: stripe.secretKey ? `••••${stripe.secretKey.slice(-4)}` : "",
      webhookUrl: `${requestOrigin(c)}/api/stripe/webhook`,
    },
    admin: {
      usingDefaultPassword: settings.admin_password_default === "1" && !c.env.ADMIN_PASSWORD,
    },
  });
});

adminApi.post("/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const clientId = typeof body.googleClientId === "string" ? body.googleClientId.trim() : "";
  const clientSecret = typeof body.googleClientSecret === "string" ? body.googleClientSecret.trim() : "";

  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new ValidationError("Enter both the Google client ID and client secret.");
    }
    if (!clientId.endsWith(".apps.googleusercontent.com")) {
      throw new ValidationError("That does not look like a Google OAuth client ID.");
    }
    const previous = await getSetting(c.env.DB, "google_client_id");
    await setSetting(c.env.DB, "google_client_id", clientId);
    await setSetting(c.env.DB, "google_client_secret", clientSecret);
    if (previous && previous !== clientId) {
      for (const key of ["google_refresh_token", "google_access_token", "google_access_expires", "google_account_email", "google_scopes"]) {
        await setSetting(c.env.DB, key, "");
      }
    }
  }

  if (body.stripeSecretKey || body.stripeWebhookSecret) {
    await saveStripeSettings(c.env, c.env.DB, {
      secretKey: body.stripeSecretKey,
      webhookSecret: body.stripeWebhookSecret,
    });
  }
  return c.json({ ok: true });
});

adminApi.post("/password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  if (next.length < 8) throw new ValidationError("Use a password of at least 8 characters.");
  let ok = false;
  if (c.env.ADMIN_PASSWORD) {
    ok = current === c.env.ADMIN_PASSWORD;
  } else {
    const stored = await getSetting(c.env.DB, "admin_password_hash");
    ok = stored ? await verifyPassword(current, stored) : false;
  }
  if (!ok) return c.json({ error: "The current password is not correct." }, 400);
  if (c.env.ADMIN_PASSWORD) {
    throw new ValidationError("The admin password is managed by the ADMIN_PASSWORD environment secret.");
  }
  await setSetting(c.env.DB, "admin_password_hash", await hashPassword(next));
  await setSetting(c.env.DB, "admin_password_default", "0");
  return c.json({ ok: true });
});

adminApi.get("/google/calendars", async (c) => {
  const calendars = await listGoogleCalendars(c.env, c.env.DB);
  return c.json({ calendars: calendars.map((cal) => ({ id: cal.id, name: cal.summary, primary: Boolean(cal.primary), role: cal.accessRole })) });
});

adminApi.post("/google/calendar", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = String(body.calendarId || "");
  if (!id) throw new ValidationError("Choose a calendar.");
  const cal = await getCalendar(c.env, c.env.DB, id);
  await setSetting(c.env.DB, "google_calendar_id", cal.id);
  await setSetting(c.env.DB, "google_calendar_name", cal.summary);
  await clearBusyCache(c.env.DB);
  return c.json({ ok: true, calendar: { id: cal.id, name: cal.summary } });
});

adminApi.post("/google/disconnect", async (c) => {
  for (const key of ["google_refresh_token", "google_access_token", "google_access_expires", "google_account_email", "google_scopes", "google_busy_cache"]) {
    await setSetting(c.env.DB, key, "");
  }
  return c.json({ ok: true });
});

adminApi.post("/google/test", async (c) => {
  const result = await testCalendarAccess(c.env, c.env.DB);
  return c.json(result);
});

app.route("/api/admin", adminApi);

/* ------------------------------------------------------------------ */
/* Google OAuth (browser redirects, not JSON)                          */
/* ------------------------------------------------------------------ */

app.get("/admin/google/start", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  try {
    const state = newToken(16);
    const oauthOrigin = publicOrigin(c);
    const cookieOptions = {
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 600,
    };
    setCookie(c, "afu_oauth_state", state, cookieOptions);
    // Remember where the browser started so the callback uses the same
    // redirect URI even when the API is proxied from another public origin.
    setCookie(c, "afu_oauth_origin", oauthOrigin, cookieOptions);
    const url = await googleAuthUrl(c.env, c.env.DB, oauthOrigin, state);
    return c.redirect(url);
  } catch (err) {
    const message = encodeURIComponent(err instanceof Error ? err.message : "Google connection could not start.");
    return c.redirect(`/admin?google=config&message=${message}#setup`);
  }
});

app.get("/admin/google/callback", async (c) => {
  if (!(await isAdmin(c))) return c.redirect("/admin");
  const state = c.req.query("state") || "";
  const expected = getCookie(c, "afu_oauth_state") || "";
  const savedOrigin = getCookie(c, "afu_oauth_origin") || "";
  deleteCookie(c, "afu_oauth_state", { path: "/" });
  deleteCookie(c, "afu_oauth_origin", { path: "/" });
  if (!state || state !== expected) {
    return c.redirect("/admin?google=state#setup");
  }
  const error = c.req.query("error");
  if (error) {
    return c.redirect(`/admin?google=error&message=${encodeURIComponent(error)}#setup`);
  }
  try {
    const oauthOrigin = allowedOrigin(c, savedOrigin) || publicOrigin(c);
    await exchangeGoogleCode(c.env, c.env.DB, c.req.query("code") || "", redirectUri(oauthOrigin));
    const cal = await resolveDeliveryCalendar(c.env, c.env.DB);
    await clearBusyCache(c.env.DB);
    return c.redirect(`/admin?google=connected&calendar=${encodeURIComponent(cal.name)}#setup`);
  } catch (err) {
    const message = encodeURIComponent(err instanceof Error ? err.message : "Google connection failed.");
    return c.redirect(`/admin?google=error&message=${message}#setup`);
  }
});

/* ------------------------------------------------------------------ */
/* Page aliases and fallbacks                                           */
/* ------------------------------------------------------------------ */

app.get("/admin", (c) => serveAsset(c, "/admin.html"));
app.get("/confirmation", (c) => serveAsset(c, "/confirmation.html"));
app.get("/demo-pay", (c) => serveAsset(c, "/demo-pay.html"));
app.get("/admin/google", (c) => c.redirect("/admin#setup"));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
  // Serve real static files (app.js, styles.css, images, admin.html…) first,
  // then fall back to the shop page for client-side routes.
  const asset = await serveAsset(c, c.req.path);
  if (asset.status !== 404) return asset;
  return serveAsset(c, "/index.html");
});

export default app;
