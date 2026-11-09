/**
 * Verifies Stripe webhook signature handling and payment finalisation without
 * needing a real Stripe key. Run against a local Worker.
 */
import crypto from "node:crypto";

const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const cookies = new Map();
const WEBHOOK_SECRET = "whsec_local_smoke_test_secret";

async function req(path, { method = "GET", body, raw, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body || raw ? { "content-type": "application/json" } : {}),
      ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  for (const value of res.headers.getSetCookie?.() ?? []) {
    const pair = value.split(";")[0];
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

function signed(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function main() {
  console.log(`Stripe webhook smoke test against ${BASE}`);

  const login = await req("/api/admin/login", { method: "POST", body: { password: "firewood2026" } });
  assert(login.status === 200, "admin sign-in");

  const settings = await req("/api/admin/settings", {
    method: "POST",
    body: { stripeWebhookSecret: WEBHOOK_SECRET },
  });
  assert(settings.status === 200, "webhook signing secret can be saved independently of a Stripe key");

  const availability = await req("/api/availability?days=45");
  let chosen = null;
  for (const day of availability.data.days) {
    const window = day.windows.find((w) => w.state === "available");
    if (window) { chosen = { date: day.date, windowId: window.id }; break; }
  }
  assert(Boolean(chosen), "available slot found");

  const reservation = await req("/api/reservations", {
    method: "POST",
    body: {
      items: [{ id: "logs-20-nets", qty: 1 }],
      customer: {
        name: "Webhook Test Customer",
        email: "webhook.test@example.com",
        phone: "07700 900222",
        address1: "2 Calendar Close",
        city: "Norwich",
        postcode: "NR1 1AA",
        notes: "Signature test",
      },
      delivery: chosen,
    },
  });
  assert(reservation.status === 201, "reservation created for webhook test");
  const ref = reservation.data.ref;

  const search = await req(`/api/admin/orders?q=${encodeURIComponent(ref)}`);
  const row = search.data.orders.find((o) => o.ref === ref);
  assert(Boolean(row), "reservation visible to admin");
  const orderId = row.id;

  const payload = JSON.stringify({
    id: `evt_test_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${Date.now()}`,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: row.total_pence,
        metadata: { order_id: orderId, order_ref: ref },
      },
    },
  });

  const invalid = await req("/api/stripe/webhook", {
    method: "POST",
    raw: payload,
    headers: { "stripe-signature": "t=1,v1=deadbeef" },
  });
  assert(invalid.status === 400, "invalid webhook signature is rejected");

  const valid = await req("/api/stripe/webhook", {
    method: "POST",
    raw: payload,
    headers: { "stripe-signature": signed(payload) },
  });
  assert(valid.status === 200, "validly signed webhook is accepted");

  const detail = await req(`/api/admin/orders/${orderId}`);
  assert(detail.data.order.payment_status === "paid", "webhook finalises the order as paid");
  assert(
    !detail.data.order.calendar_event_id && detail.data.order.calendar_error,
    "calendar failure is recorded for retry instead of losing the payment",
  );

  const firstPaidAt = detail.data.order.paid_at;
  const duplicate = await req("/api/stripe/webhook", {
    method: "POST",
    raw: payload,
    headers: { "stripe-signature": signed(payload) },
  });
  assert(duplicate.status === 200, "duplicate webhook is acknowledged");
  const after = await req(`/api/admin/orders/${orderId}`);
  assert(after.data.order.paid_at === firstPaidAt, "duplicate webhook does not re-run finalisation");

  await req(`/api/admin/orders/${orderId}`, { method: "PATCH", body: { status: "cancelled" } });
  console.log("\nWebhook tests passed.");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
