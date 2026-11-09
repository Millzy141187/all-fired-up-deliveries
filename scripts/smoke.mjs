/**
 * End-to-end smoke test against a running local Worker.
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
const BASE = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const cookies = new Map();

async function req(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookies.size
        ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }
        : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
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

function findSlot(availability) {
  for (const day of availability.days) {
    for (const window of day.windows) {
      if (window.state === "available" && window.remaining > 0) {
        return { date: day.date, windowId: window.id, booked: window.booked, dayBooked: day.booked };
      }
    }
  }
  return null;
}

async function main() {
  console.log(`Smoke testing ${BASE}`);

  const health = await req("/api/health");
  assert(health.status === 200 && health.data.ok, "health endpoint responds");

  const boot = await req("/api/bootstrap");
  assert(boot.status === 200 && boot.data.products.length >= 6, "catalogue loads with products");
  assert(boot.data.stripe.mode === "none", "Stripe starts in demo mode for this run");
  assert(boot.data.calendar.connected === false, "Google Calendar not connected in local test");

  const availability = await req("/api/availability?days=35");
  assert(availability.status === 200 && availability.data.days.length > 0, "availability returns eligible weekdays");
  const firstDay = availability.data.days[0];
  assert(firstDay.windows.every((w) => w.state !== "past"), "returned days meet the 24-hour notice rule");

  const chosen = findSlot(availability.data);
  assert(Boolean(chosen), "an available delivery slot exists");

  const customer = {
    name: "Smoke Test Customer",
    email: "smoke.test@example.com",
    phone: "07700 900111",
    address1: "1 Test Lane",
    city: "Dereham",
    postcode: "NR19 2LA",
    notes: "Leave by side gate",
  };

  // 24-hour rule
  const tooSoon = await req("/api/reservations", {
    method: "POST",
    body: {
      items: [{ id: "large-dumpy-bag", qty: 1 }],
      customer,
      delivery: { date: new Date().toISOString().slice(0, 10), windowId: 1 },
    },
  });
  assert(tooSoon.status === 409, "same-day booking is rejected");

  // Out-of-area rule
  const outOfArea = await req("/api/reservations", {
    method: "POST",
    body: {
      items: [{ id: "large-dumpy-bag", qty: 1 }],
      customer: { ...customer, postcode: "SW1A 1AA" },
      delivery: chosen,
    },
  });
  assert(outOfArea.status === 422, "postcode outside NR/IP/PE/CB is rejected");

  // Add-on rule
  const addonOnly = await req("/api/reservations", {
    method: "POST",
    body: {
      items: [{ id: "kindling", qty: 1 }],
      customer,
      delivery: chosen,
    },
  });
  assert(addonOnly.status === 400, "kindling cannot be ordered without firewood");

  // Create a real reservation
  const reservation = await req("/api/reservations", {
    method: "POST",
    body: {
      items: [
        { id: "large-dumpy-bag", qty: 1 },
        { id: "kindling", qty: 1 },
      ],
      customer,
      delivery: chosen,
    },
  });
  assert(reservation.status === 201, "reservation is created");
  assert(reservation.data.order.paymentStatus === "unpaid", "new order is unpaid");
  assert(reservation.data.order.total === 16200, "server totals include the £12 delivery fee and test prices");
  const ref = reservation.data.ref;
  const token = reservation.data.token;

  const held = await req(`/api/availability?days=35`);
  const heldWindow = held.data.days.find((d) => d.date === chosen.date)?.windows.find((w) => w.id === chosen.windowId);
  assert(heldWindow.booked === chosen.booked + 1, "active reservation immediately reduces availability");

  // Demo payment (no Stripe key configured)
  const paid = await req("/api/demo/confirm", { method: "POST", body: { ref, token } });
  assert(paid.status === 200 && paid.data.order.paymentStatus === "paid", "demo test payment confirms the order");
  assert(paid.data.order.calendarSynced === false, "calendar sync is reported as pending without a connection");

  const lookup = await req(`/api/orders/${ref}?token=${encodeURIComponent(token)}`);
  assert(lookup.status === 200 && lookup.data.order.paymentStatus === "paid", "confirmation lookup requires the token and returns paid order");

  const wrongToken = await req(`/api/orders/${ref}?token=wrong`);
  assert(wrongToken.status === 404, "order lookup rejects a bad access token");

  // Admin auth
  const unauth = await req("/api/admin/orders");
  assert(unauth.status === 401, "admin API is protected");

  const login = await req("/api/admin/login", { method: "POST", body: { password: "firewood2026" } });
  assert(login.status === 200, "admin login accepts the demo password");

  const session = await req("/api/admin/session");
  assert(session.status === 200 && session.data.usingDefaultPassword === true, "session flags the default password");

  const orders = await req("/api/admin/orders");
  assert(orders.status === 200 && orders.data.orders.some((o) => o.ref === ref), "admin order list includes the paid order");
  assert(!("public_token" in orders.data.orders[0]), "admin list does not leak customer tokens");

  const stats = await req("/api/admin/stats");
  assert(stats.status === 200 && stats.data.upcomingOrders >= 1, "dashboard stats count upcoming paid orders");

  // Blocking a day with paid orders must warn and require acknowledgement
  const warning = await req("/api/admin/blocks", {
    method: "POST",
    body: { date: chosen.date, windowId: null, capacity: 0, note: "Smoke test closure" },
  });
  assert(warning.status === 409 && warning.data.requiresAcknowledgement === true, "closing a day with paid orders warns first");
  assert(
    warning.data.warning.includes("paid order"),
    "warning uses the required customer-contact message",
  );

  const acknowledged = await req("/api/admin/blocks", {
    method: "POST",
    body: { date: chosen.date, windowId: null, capacity: 0, note: "Smoke test closure", acknowledge: true },
  });
  assert(acknowledged.status === 201, "closure can be confirmed after acknowledgement");

  const closedDay = await req("/api/availability?days=35");
  assert(
    closedDay.data.days.find((d) => d.date === chosen.date)?.closed === true,
    "closed day shows no deliveries",
  );

  const blockId = acknowledged.data.block.id;
  const unblocked = await req(`/api/admin/blocks/${blockId}`, { method: "DELETE" });
  assert(unblocked.status === 200, "day closure can be removed");

  // Capacity locking: fill a fresh window completely, then expect a rejection
  const fresh = await req("/api/availability?days=60");
  let thirdSlot = null;
  for (const day of fresh.data.days) {
    const window = day.windows.find((w) => w.state === "available" && w.remaining === 2 && w.capacity === 2);
    if (window) { thirdSlot = { date: day.date, windowId: window.id }; break; }
  }
  assert(Boolean(thirdSlot), "a fresh window with two spaces exists");

  const makeReservation = () => req("/api/reservations", {
    method: "POST",
    body: { items: [{ id: "logs-20-nets", qty: 1 }], customer, delivery: thirdSlot },
  });
  const firstHold = await makeReservation();
  const secondHold = await makeReservation();
  assert(firstHold.status === 201 && secondHold.status === 201, "both spaces in a two-space window can be held");
  const thirdHold = await makeReservation();
  assert(thirdHold.status === 409, "a third concurrent reservation is rejected (no double booking)");

  const windowAvailability = await req("/api/availability?days=60");
  const filled = windowAvailability.data.days
    .find((d) => d.date === thirdSlot.date)?.windows.find((w) => w.id === thirdSlot.windowId);
  assert(filled.state === "full" && filled.remaining === 0, "full window shows Fully booked");

  // Release the holds so the test leaves capacity tidy
  await req("/api/reservations/release", {
    method: "POST",
    body: { ref: firstHold.data.ref, token: firstHold.data.token },
  });
  await req("/api/reservations/release", {
    method: "POST",
    body: { ref: secondHold.data.ref, token: secondHold.data.token },
  });

  // Cancel the paid order; slot should be freed and calendar untouched
  const orderId = paid.data.order.ref;
  const detail = await req(`/api/admin/orders?q=${orderId}`);
  const orderRow = detail.data.orders.find((o) => o.ref === ref);
  const cancelled = await req(`/api/admin/orders/${orderRow.id}`, {
    method: "PATCH",
    body: { status: "cancelled" },
  });
  assert(cancelled.status === 200 && cancelled.data.order.status === "cancelled", "admin can cancel a paid order");

  const afterCancel = await req("/api/availability?days=35");
  const freed = afterCancel.data.days.find((d) => d.date === chosen.date)?.windows.find((w) => w.id === chosen.windowId);
  assert(freed.booked === chosen.booked, "cancelling immediately frees the delivery slot");

  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
