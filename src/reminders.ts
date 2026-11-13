import type { D1Database } from "@cloudflare/workers-types";
import { getSetting, orderItems, setSetting, type Env, type OrderRow } from "./db";
import { GMAIL_SEND_SCOPE, formatMoney, sendCustomerEmail } from "./google";
import { formatLongDate, nowLondonTime, todayLondon } from "./time";

/** Reminders go out from this London wall-clock time on the delivery day. */
export const MORNING_REMINDER_TIME = "07:30";

export interface ReminderRunResult {
  date: string;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface ReminderOverview {
  date: string;
  autoTime: string;
  emailReady: boolean;
  deliveriesToday: number;
  sentToday: number;
  pending: number;
  autoRanToday: boolean;
  lastError: string;
}

export async function googleEmailReady(db: D1Database): Promise<boolean> {
  const [token, scopes] = await Promise.all([
    getSetting(db, "google_refresh_token"),
    getSetting(db, "google_scopes"),
  ]);
  return Boolean(token) && (scopes || "").split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}

function reminderEmail(order: OrderRow, items: { name: string; qty: number }[]) {
  const address = [order.address1, order.address2, order.city, order.postcode]
    .filter(Boolean)
    .join(", ");
  const contents = items.map((item) => `${item.qty} × ${item.name}`).join(", ");
  return {
    subject: `Your firewood delivery is today — ${order.ref}`,
    body: [
      `Hi ${firstName(order.customer_name)},`,
      "",
      "A quick reminder that your firewood delivery is booked for today.",
      "",
      `Delivery day: ${formatLongDate(order.delivery_date)}`,
      "We will text or call with a narrower arrival time on the day.",
      `Address: ${address}`,
      `Items: ${contents || "Firewood order"}`,
      `Total: ${formatMoney(order.total_pence)}`,
      "",
      "If anything has changed, just reply to this email or call 0000 000 000 and we will sort it out.",
      "",
      "Thanks,",
      "All Fired Up",
    ].join("\n"),
  };
}

const DUE_ORDERS = `SELECT o.* FROM orders o
  LEFT JOIN delivery_reminders r ON r.order_id = o.id AND r.delivery_date = o.delivery_date
  WHERE o.delivery_date = ? AND o.payment_status = 'paid' AND o.is_sample = 0
    AND o.status NOT IN ('cancelled','refunded','delivered','expired')
    AND r.order_id IS NULL
  ORDER BY o.window_id, o.created_at`;

const PENDING_COUNT = `SELECT COUNT(*) AS n FROM orders o
  LEFT JOIN delivery_reminders r ON r.order_id = o.id AND r.delivery_date = o.delivery_date
  WHERE o.delivery_date = ? AND o.payment_status = 'paid' AND o.is_sample = 0
    AND o.status NOT IN ('cancelled','refunded','delivered','expired')
    AND r.order_id IS NULL`;

/**
 * Send today's delivery reminder to every paid customer with a delivery on the
 * given date. Each order is claimed in delivery_reminders before sending, so
 * parallel requests cannot produce duplicate emails.
 */
export async function sendDeliveryReminders(
  env: Env,
  date = todayLondon(),
  opts: { retryFailed?: boolean } = {},
): Promise<ReminderRunResult> {
  const db = env.DB;
  const result: ReminderRunResult = { date, sent: 0, skipped: 0, failed: 0, errors: [] };

  if (!(await googleEmailReady(db))) {
    result.errors.push("Google email is not connected. Reconnect Google in Setup.");
    return result;
  }

  if (opts.retryFailed) {
    await db
      .prepare("DELETE FROM delivery_reminders WHERE delivery_date = ? AND state = 'failed'")
      .bind(date)
      .run();
  }

  const rows = await db.prepare(DUE_ORDERS).bind(date).all<OrderRow>();
  for (const order of rows.results ?? []) {
    if (!order.email) {
      result.skipped += 1;
      continue;
    }
    const claimedAt = new Date().toISOString();
    const claim = await db
      .prepare(
        "INSERT OR IGNORE INTO delivery_reminders (order_id, delivery_date, state, attempted_at) VALUES (?, ?, 'sending', ?)",
      )
      .bind(order.id, date, claimedAt)
      .run();
    if ((claim.meta.changes ?? 0) === 0) {
      result.skipped += 1;
      continue;
    }

    try {
      const items = await orderItems(db, order.id);
      const email = reminderEmail(order, items);
      const sent = await sendCustomerEmail(env, db, {
        to: order.email,
        subject: email.subject,
        text: email.body,
      });
      const sentAt = new Date().toISOString();
      await db.batch([
        db
          .prepare(
            "UPDATE delivery_reminders SET state = 'sent', gmail_id = ?, sent_at = ?, error = NULL WHERE order_id = ? AND delivery_date = ?",
          )
          .bind(sent.id, sentAt, order.id, date),
        db
          .prepare(
            "INSERT INTO order_emails (id, order_id, to_email, subject, body, gmail_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            order.id,
            order.email,
            email.subject,
            email.body,
            sent.id,
            sentAt,
          ),
      ]);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "The reminder could not be sent.";
      result.failed += 1;
      result.errors.push(`${order.ref}: ${message}`);
      await db
        .prepare(
          "UPDATE delivery_reminders SET state = 'failed', error = ? WHERE order_id = ? AND delivery_date = ?",
        )
        .bind(message.slice(0, 300), order.id, date)
        .run();
    }
  }

  if (result.failed) {
    await setSetting(db, "reminder_last_error", `${date} — ${result.errors[0]}`);
  } else if (result.sent) {
    await setSetting(db, "reminder_last_error", "");
  }
  return result;
}

export async function remindersOverview(
  env: Env,
  date = todayLondon(),
): Promise<ReminderOverview> {
  const db = env.DB;
  const [deliveries, sent, pending, ready, autoDate, lastError] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE delivery_date = ? AND payment_status = 'paid' AND is_sample = 0 AND status NOT IN ('cancelled','refunded','delivered','expired')",
      )
      .bind(date)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM delivery_reminders WHERE delivery_date = ? AND state = 'sent'",
      )
      .bind(date)
      .first<{ n: number }>(),
    db.prepare(PENDING_COUNT).bind(date).first<{ n: number }>(),
    googleEmailReady(db),
    getSetting(db, "reminder_auto_date"),
    getSetting(db, "reminder_last_error"),
  ]);
  return {
    date,
    autoTime: MORNING_REMINDER_TIME,
    emailReady: ready,
    deliveriesToday: deliveries?.n ?? 0,
    sentToday: sent?.n ?? 0,
    pending: pending?.n ?? 0,
    autoRanToday: autoDate === date,
    lastError: lastError || "",
  };
}

/**
 * Cloudflare Sites exposes no cron trigger, so the automatic run happens on the
 * first request after 07:30 London. The date is recorded before sending and
 * each order is claimed individually, which keeps it safe to call from every
 * request and from multiple isolates.
 */
export async function maybeSendMorningReminders(env: Env): Promise<void> {
  if (nowLondonTime() < MORNING_REMINDER_TIME) return;
  const date = todayLondon();
  if ((await getSetting(env.DB, "reminder_auto_date")) === date) return;
  await setSetting(env.DB, "reminder_auto_date", date);
  if (!(await googleEmailReady(env.DB))) return;
  await sendDeliveryReminders(env, date);
}
