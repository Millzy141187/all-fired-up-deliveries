/* All Fired Up — owner dashboard (test version). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_LABELS = {
  new: "New",
  confirmed: "Confirmed",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

const WINDOW_LABELS = ["09:00 – 11:00", "11:00 – 13:00", "13:00 – 15:00", "15:00 – 17:00"];

const state = {
  tab: "orders",
  boot: null,
  today: new Date().toISOString().slice(0, 10),
  setup: null,
  availability: null,
  blocks: [],
  calMonth: null,
  currentOrderId: null,
  blockAck: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function money(pence) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(pence) || 0) / 100);
}

function dateShort(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function dateLong(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, 1)));
}

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toast(message, kind = "") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`.trim();
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.className = "toast"; }, 4600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/* ---------- Auth ---------- */

function showLogin() {
  $("#login-view").hidden = false;
  $("#admin-view").hidden = true;
}

function showAdmin() {
  $("#login-view").hidden = true;
  $("#admin-view").hidden = false;
}

async function init() {
  try {
    const res = await fetch("/api/bootstrap");
    if (res.ok) {
      state.boot = await res.json();
      if (state.boot.today) state.today = state.boot.today;
      if (state.boot.demoPassword) {
        $("#demo-hint").hidden = false;
        $("#demo-password").textContent = state.boot.demoPassword;
      }
    }
  } catch { /* offline bootstrap is not fatal */ }

  bindEvents();

  try {
    const session = await api("/api/admin/session");
    enterAdmin(session);
  } catch {
    showLogin();
    $("#password").focus();
  }
}

function bindEvents() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#login-button");
    const errorEl = $("#login-error");
    errorEl.hidden = true;
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      await api("/api/admin/login", { method: "POST", body: { password: $("#password").value } });
      const session = await api("/api/admin/session");
      enterAdmin(session);
    } catch (err) {
      errorEl.textContent = err.message || "Sign in failed.";
      errorEl.hidden = false;
      $("#password").select();
    } finally {
      button.disabled = false;
      button.textContent = "Sign in →";
    }
  });

  $("#logout").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST" }); } catch { /* ignore */ }
    showLogin();
    $("#password").value = "";
  });

  $$(".admin-tabs button").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });

  $("#refresh-orders").addEventListener("click", () => { loadStats(); loadOrders(); });

  let searchTimer;
  $("#order-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadOrders, 260);
  });
  $("#order-status").addEventListener("change", loadOrders);
  $("#order-date").addEventListener("change", loadOrders);

  $("#orders-body").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (row) openOrder(row.dataset.id);
  });

  $("#cal-prev").addEventListener("click", () => loadCalendar(shiftMonth(state.calMonth, -1)));
  $("#cal-next").addEventListener("click", () => loadCalendar(shiftMonth(state.calMonth, 1)));
  $("#cal-grid").addEventListener("click", (event) => {
    const cell = event.target.closest("button[data-date]");
    if (cell) loadDay(cell.dataset.date);
  });
  $("#day-schedule").addEventListener("click", (event) => {
    const item = event.target.closest("[data-order-id]");
    if (item) openOrder(item.dataset.orderId);
  });

  $("#add-block").addEventListener("click", () => openBlockDialog(state.today));
  $("#availability-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-block-date]");
    if (!button) return;
    const date = button.dataset.blockDate;
    const existing = state.blocks.find((block) => block.date === date && block.window_id === null)
      || state.blocks.find((block) => block.date === date);
    openBlockDialog(date, existing || null);
  });
  $("#block-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-block]");
    if (!button) return;
    if (!confirm("Remove this block? The delivery slot will become bookable again.")) return;
    try {
      const result = await api(`/api/admin/blocks/${button.dataset.deleteBlock}`, { method: "DELETE" });
      toast(result.warning || "Block removed.");
      await loadAvailability();
      if (state.calMonth) loadCalendar(state.calMonth);
    } catch (err) {
      toast(err.message || "The block could not be removed.", "error");
    }
  });

  $$("[data-close]").forEach((button) => {
    button.addEventListener("click", () => $("#order-dialog").close());
  });
  $$("[data-block-close]").forEach((button) => {
    button.addEventListener("click", () => $("#block-dialog").close());
  });

  $("#order-body").addEventListener("click", async (event) => {
    const statusButton = event.target.closest("[data-set-status]");
    if (!statusButton) return;
    const status = statusButton.dataset.setStatus;
    if (["cancelled", "refunded"].includes(status)) {
      const label = status === "refunded" ? "mark this order refunded" : "cancel this order";
      if (!confirm(`Are you sure you want to ${label}? Its delivery slot will be freed and the calendar event removed.`)) return;
    }
    statusButton.disabled = true;
    try {
      const result = await api(`/api/admin/orders/${state.currentOrderId}`, {
        method: "PATCH",
        body: { status },
      });
      toast(result.warning || `Order marked ${STATUS_LABELS[status] || status}.`, result.warning ? "error" : "");
      await openOrder(state.currentOrderId, false);
      loadOrders();
      loadStats();
      if (state.calMonth) loadCalendar(state.calMonth);
    } catch (err) {
      toast(err.message || "The status could not be updated.", "error");
    } finally {
      statusButton.disabled = false;
    }
  });

  $("#order-calendar").addEventListener("click", async () => {
    if (!state.currentOrderId) return;
    const button = $("#order-calendar");
    button.disabled = true;
    button.textContent = "Adding…";
    try {
      await api(`/api/admin/orders/${state.currentOrderId}/calendar`, { method: "POST" });
      toast("Delivery event added to Google Calendar.");
      await openOrder(state.currentOrderId, false);
      loadOrders();
      loadStats();
    } catch (err) {
      toast(err.message || "The calendar event could not be created.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Retry calendar sync";
    }
  });

  $("#block-scope").addEventListener("change", toggleBlockFields);
  for (const selector of ["#block-date", "#block-scope", "#block-window", "#block-capacity"]) {
    $(selector).addEventListener("change", () => {
      state.blockAck = false;
      $("#block-warning").hidden = true;
      $("#block-submit").textContent = "Save block";
    });
  }
  $("#block-form").addEventListener("submit", submitBlock);

  $("#google-client-form").addEventListener("submit", saveGoogleClient);
  $("#save-calendar").addEventListener("click", saveCalendarChoice);
  $("#google-test").addEventListener("click", testGoogle);
  $("#google-disconnect").addEventListener("click", disconnectGoogle);
  $("#stripe-form").addEventListener("submit", saveStripe);
  $("#password-form").addEventListener("submit", changePassword);

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      toast("Copied.");
    } catch {
      toast("Select and copy the value manually.", "error");
    }
  });
}

function enterAdmin(session) {
  showAdmin();
  $("#admin-mode").textContent = state.boot?.stripe?.configured ? "Stripe test mode active" : "Stripe test mode · demo checkout";
  const query = new URLSearchParams(location.search);
  const google = query.get("google");
  if (google === "connected") {
    toast(`Google Calendar connected${query.get("calendar") ? ` — ${query.get("calendar")}` : ""}.`);
    history.replaceState(null, "", "/admin#setup");
    showTab("setup");
    return;
  }
  if (google) {
    const message = query.get("message") || (google === "state" ? "The sign-in request expired. Please try again." : "Google Calendar could not be connected.");
    toast(message, "error");
    history.replaceState(null, "", "/admin#setup");
    showTab("setup");
    return;
  }

  const hash = location.hash.replace("#", "");
  const initial = ["orders", "calendar", "availability", "setup"].includes(hash) ? hash : "orders";
  showTab(initial);
  if (session?.usingDefaultPassword) {
    $("#default-password-note").hidden = false;
  }
}

/* ---------- Tabs ---------- */

function showTab(tab) {
  if (!["orders", "calendar", "availability", "setup"].includes(tab)) tab = "orders";
  state.tab = tab;
  $$(".admin-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  $$("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  history.replaceState(null, "", `/admin#${tab}`);

  if (tab === "orders") { loadStats(); loadOrders(); }
  if (tab === "calendar") loadCalendar(state.calMonth || state.today.slice(0, 7));
  if (tab === "availability") loadAvailability();
  if (tab === "setup") loadSetup();
}

/* ---------- Orders ---------- */

async function loadStats() {
  try {
    const stats = await api("/api/admin/stats");
    $("#stat-upcoming").textContent = stats.upcomingOrders;
    $("#stat-today").textContent = stats.todayOrders;
    $("#stat-value").textContent = money(stats.upcomingValue);
    $("#stat-issues").textContent = stats.calendarIssues;
    $("#stat-issues-card").hidden = !stats.calendarConnected;
  } catch { /* the list below will surface errors */ }
}

async function loadOrders() {
  const params = new URLSearchParams();
  const q = $("#order-search").value.trim();
  const status = $("#order-status").value;
  const date = $("#order-date").value;
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (date) params.set("date", date);

  try {
    const data = await api(`/api/admin/orders?${params.toString()}`);
    renderOrders(data.orders);
    $("#order-count").textContent = `${data.orders.length} ${data.orders.length === 1 ? "order" : "orders"}`;
  } catch (err) {
    $("#orders-body").innerHTML = "";
    $("#orders-empty").hidden = false;
    $("#orders-empty").textContent = err.message || "Orders could not be loaded.";
  }
}

function renderOrders(orders) {
  const body = $("#orders-body");
  $("#orders-empty").hidden = orders.length > 0;
  body.innerHTML = orders.map((order) => `
    <tr data-id="${esc(order.id)}">
      <td>
        <div class="ref">${esc(order.ref)}</div>
        <div class="sub">${order.is_sample ? `<span class="badge sample">Sample</span>` : `Created ${esc(new Date(order.created_at).toLocaleDateString("en-GB"))}`}</div>
      </td>
      <td>
        <div class="cust">${esc(order.customer_name)}</div>
        <div class="sub">${esc(order.postcode)} · ${esc(order.phone)}</div>
      </td>
      <td>
        <div>${dateShort(order.delivery_date)}</div>
        <div class="sub">${esc(order.window_label)}</div>
      </td>
      <td style="max-width:220px"><div class="sub">${esc(order.itemsSummary || "—")}</div></td>
      <td class="money">${money(order.total_pence)}</td>
      <td><span class="badge ${esc(order.payment_status)}">${esc(order.payment_status)}</span></td>
      <td><span class="badge ${esc(order.status)}">${esc(STATUS_LABELS[order.status] || order.status)}</span></td>
    </tr>`).join("");
}

async function openOrder(id, show = true) {
  try {
    const data = await api(`/api/admin/orders/${id}`);
    state.currentOrderId = id;
    renderOrder(data);
    if (show) $("#order-dialog").showModal();
  } catch (err) {
    toast(err.message || "Order could not be loaded.", "error");
  }
}

function renderOrder(data) {
  const order = data.order;
  const items = data.items || [];
  $("#order-title").textContent = order.ref;
  $("#order-subtitle").textContent = `${dateLong(order.delivery_date)} · ${order.window_label}${order.is_sample ? " · sample order" : ""}`;
  $("#order-calendar").hidden = !(order.payment_status === "paid" && !order.calendar_event_id);

  const calendar = order.calendar_event_id
    ? `<p><span class="badge delivered">In calendar</span></p>
       <p style="font-size:.78rem;color:var(--muted);margin-top:6px">${esc(data.calendarName)}<br>Event ${esc(order.calendar_event_id)}</p>
       ${order.calendar_event_link ? `<p style="margin-top:6px"><a href="${esc(order.calendar_event_link)}" target="_blank" rel="noopener">Open in Google Calendar</a></p>` : ""}`
    : order.payment_status === "paid"
      ? `<p><span class="badge unpaid">Not synced</span></p>
         ${order.calendar_error ? `<div class="issue">${esc(order.calendar_error)}</div>` : `<p style="font-size:.78rem;color:var(--muted);margin-top:6px">No calendar event yet. Add Stripe or Google settings, then retry.</p>`}`
      : `<p style="font-size:.82rem;color:var(--muted)">The calendar event is created only after a confirmed payment.</p>`;

  $("#order-body").innerHTML = `
    <div class="order-detail-grid">
      <div class="detail-block">
        <h4>Customer</h4>
        <p><strong>${esc(order.customer_name)}</strong></p>
        <p>${esc(order.phone)}</p>
        <p style="overflow-wrap:anywhere">${esc(order.email)}</p>
      </div>
      <div class="detail-block">
        <h4>Delivery address</h4>
        <p>${esc(order.address1)}${order.address2 ? `<br>${esc(order.address2)}` : ""}<br>${esc(order.city)}<br><strong>${esc(order.postcode)}</strong></p>
        <p style="margin-top:6px">${dateShort(order.delivery_date)} · ${esc(order.window_label)}</p>
      </div>
    </div>

    <div class="detail-block" style="margin-top:12px">
      <h4>Order contents</h4>
      <table class="order-items">
        <tbody>
          ${items.map((item) => `<tr><td>${item.qty} × ${esc(item.name)}</td><td>${money(item.line_pence)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(order.subtotal_pence)}</span></div>
        <div><span>Delivery</span><span>${order.delivery_pence === 0 ? "Free" : money(order.delivery_pence)}</span></div>
        <div class="grand"><span>Total</span><span>${money(order.total_pence)}</span></div>
      </div>
    </div>

    <div class="review-grid" style="margin-top:12px">
      <div class="detail-block">
        <h4>Payment</h4>
        <p><span class="badge ${esc(order.payment_status)}">${esc(order.payment_status)}</span></p>
        <p style="font-size:.78rem;color:var(--muted);margin-top:6px">Stripe test mode · order ${esc(order.ref)}</p>
        ${order.paid_at ? `<p style="font-size:.78rem;color:var(--muted)">Paid ${esc(new Date(order.paid_at).toLocaleString("en-GB"))}</p>` : ""}
      </div>
      <div class="detail-block">
        <h4>Google Calendar</h4>
        ${calendar}
      </div>
    </div>

    ${order.notes ? `<div class="detail-block" style="margin-top:12px"><h4>Delivery / access notes</h4><p>${esc(order.notes)}</p></div>` : ""}

    <div class="detail-block" style="margin-top:12px">
      <h4>Order status</h4>
      <div class="status-actions">
        ${Object.entries(STATUS_LABELS).map(([value, label]) => `
          <button type="button" data-set-status="${value}" class="${order.status === value ? "current" : ""}">${label}</button>
        `).join("")}
      </div>
      ${order.delivered_at ? `<p style="font-size:.76rem;color:var(--muted);margin-top:8px">Marked delivered ${esc(new Date(order.delivered_at).toLocaleString("en-GB"))}</p>` : ""}
    </div>
  `;
}

/* ---------- Calendar ---------- */

async function loadCalendar(month) {
  state.calMonth = month;
  try {
    const data = await api(`/api/admin/calendar?month=${encodeURIComponent(month)}`);
    renderCalendar(data);
  } catch (err) {
    toast(err.message || "Calendar could not be loaded.", "error");
  }
}

function renderCalendar(data) {
  $("#cal-title").textContent = monthLabel(data.month);
  const grid = $("#cal-grid");
  grid.innerHTML = data.cells.map((cell) => {
    if (!cell.inMonth) return `<div class="cal-cell blank"></div>`;
    const classes = [
      "cal-cell",
      cell.weekend ? "weekend" : "",
      cell.blocked ? "blocked" : "",
      cell.date === state.today ? "today" : "",
    ].filter(Boolean).join(" ");
    return `
      <button type="button" class="${classes}" data-date="${cell.date}">
        <span class="d">${Number(cell.date.slice(-2))}</span>
        ${cell.orders ? `<span class="o">${cell.orders} ${cell.orders === 1 ? "delivery" : "deliveries"}</span>` : ""}
        ${cell.blocked ? `<span class="b">Closed</span>` : ""}
        <span class="m">${cell.paid ? `${cell.paid} paid` : ""}</span>
      </button>`;
  }).join("");

  const firstWithOrders = data.cells.find((cell) => cell.inMonth && cell.orders > 0);
  const firstWeekday = data.cells.find((cell) => cell.inMonth && !cell.weekend);
  const initial = firstWithOrders || firstWeekday;
  if (initial) loadDay(initial.date);
}

async function loadDay(date) {
  try {
    const data = await api(`/api/admin/schedule?date=${encodeURIComponent(date)}`);
    $("#day-panel").hidden = false;
    $("#day-panel-title").textContent = data.label;
    const day = data.day;

    const windowHtml = day ? `
      <div class="slots" style="margin:4px 0 14px">
        ${day.windows.map((win) => {
          const label = win.state === "available"
            ? `${win.booked}/${win.capacity} booked`
            : win.state === "full" || win.state === "busy"
              ? "Fully booked"
              : win.state === "blocked" ? "Blocked" : "No notice";
          return `<span class="slot-pill ${win.state === "available" ? "" : "blocked"}">${esc(win.label)} · ${esc(label)}</span>`;
        }).join("")}
      </div>` : "";

    const blocksHtml = data.blocks.length
      ? `<div style="margin-bottom:12px">${data.blocks.map((block) => `
          <div class="sched-item block">
            <div><div class="when">${block.window_id ? esc(WINDOW_LABELS[block.window_id - 1]) : "Whole day"}</div>
              <div class="who">Blocked — no deliveries</div></div>
            <div class="what">${esc(block.note || "No internal note")}</div>
          </div>`).join("")}</div>`
      : "";

    const ordersHtml = data.orders.length
      ? data.orders.map((order) => `
        <div class="sched-item" data-order-id="${esc(order.id)}" style="cursor:pointer">
          <div>
            <div class="when">${esc(order.window_label)}</div>
            <div class="who">${esc(order.customer_name)} <span class="badge ${esc(order.status)}">${esc(STATUS_LABELS[order.status] || order.status)}</span></div>
            <div class="what">${esc(order.itemsSummary || "")}</div>
          </div>
          <div class="what" style="text-align:right">${esc(order.postcode)}<br>${money(order.total_pence)}</div>
        </div>`).join("")
      : `<p class="empty" style="padding:18px 0">No orders on this day.</p>`;

    $("#day-schedule").innerHTML = windowHtml + blocksHtml + ordersHtml;
  } catch (err) {
    toast(err.message || "The day schedule could not be loaded.", "error");
  }
}

/* ---------- Availability ---------- */

async function loadAvailability() {
  try {
    const [availability, blocks] = await Promise.all([
      api(`/api/admin/availability?days=56`),
      api(`/api/admin/blocks?from=${state.today}&to=${endDate(90)}`),
    ]);
    state.availability = availability;
    state.blocks = blocks.blocks || [];
    renderAvailability();
    renderBlocks();
  } catch (err) {
    $("#availability-list").innerHTML = `<div class="empty">${esc(err.message || "Availability could not be loaded.")}</div>`;
  }
}

function endDate(days) {
  const d = new Date(`${state.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function renderAvailability() {
  const list = $("#availability-list");
  const days = state.availability?.days || [];
  if (!days.length) {
    list.innerHTML = `<div class="empty">No delivery days found.</div>`;
    return;
  }

  list.innerHTML = days.map((day) => {
    const blockedWindows = day.windows.filter((win) => win.state === "blocked").length;
    const reduced = day.windows.filter((win) => win.capacity === 1).length;
    const note = day.note || day.windows.find((win) => win.blockNote)?.blockNote || "";
    return `
      <div class="block-day-row">
        <div>
          <div class="date">${esc(day.label)}</div>
          <div class="block-note">${day.closed ? "Closed" : `${day.booked} of ${day.capacity} booked`}${note ? ` · ${esc(note)}` : ""}</div>
        </div>
        <div class="slots">
          ${day.windows.map((win) => `
            <span class="slot-pill ${win.state === "available" ? "" : "blocked"}" title="${esc(win.reason || "")}">
              ${esc(win.label)} · ${win.state === "blocked" ? "Closed" : `${win.booked}/${win.capacity}`}
            </span>`).join("")}
          ${day.closed ? `<span class="slot-pill blocked">No deliveries available</span>` : ""}
          ${reduced && !day.closed ? `<span class="slot-pill">Reduced capacity</span>` : ""}
          ${blockedWindows && !day.closed ? `<span class="slot-pill blocked">${blockedWindows} window${blockedWindows === 1 ? "" : "s"} blocked</span>` : ""}
        </div>
        <div>
          <button class="btn btn-outline btn-sm" type="button" data-block-date="${esc(day.date)}">Block / edit</button>
        </div>
      </div>`;
  }).join("");
}

function renderBlocks() {
  const list = $("#block-list");
  if (!state.blocks.length) {
    list.innerHTML = `<div class="empty">No blocked days or reduced-capacity windows.</div>`;
    return;
  }
  list.innerHTML = state.blocks.map((block) => `
    <div class="block-day-row">
      <div>
        <div class="date">${dateShort(block.date)}</div>
        <div class="block-note">${esc(block.note || "No internal note")}</div>
      </div>
      <div class="slots">
        <span class="slot-pill ${block.capacity === 0 ? "blocked" : ""}">
          ${block.window_id ? esc(WINDOW_LABELS[block.window_id - 1]) : "Whole day"}
          ${block.capacity === 0 ? "· Closed" : `· ${block.capacity} deliver${block.capacity === 1 ? "y" : "ies"}`}
        </span>
        ${block.calendar_event_id ? `<span class="slot-pill">Calendar event created</span>` : ""}
      </div>
      <div>
        <button class="btn btn-outline btn-sm" type="button" data-delete-block="${esc(block.id)}">Remove</button>
      </div>
    </div>`).join("");
}

function toggleBlockFields() {
  const windowScope = $("#block-scope").value === "window";
  $("#block-window-field").hidden = !windowScope;
  $("#block-capacity-field").hidden = !windowScope;
  $("#block-capacity").disabled = !windowScope;
}

function openBlockDialog(date, block = null) {
  state.blockAck = false;
  $("#block-warning").hidden = true;
  $("#block-submit").textContent = "Save block";
  $("#block-date").value = date;
  $("#block-date").min = state.today;
  $("#block-note").value = block?.note || "";

  if (block) {
    if (block.window_id) {
      $("#block-scope").value = "window";
      $("#block-window").value = String(block.window_id);
      $("#block-capacity").value = String(block.capacity);
    } else {
      $("#block-scope").value = "day";
    }
  } else {
    $("#block-scope").value = "day";
    $("#block-capacity").value = "0";
  }
  toggleBlockFields();
  $("#block-dialog").showModal();
}

async function submitBlock(event) {
  event.preventDefault();
  const scope = $("#block-scope").value;
  const payload = {
    date: $("#block-date").value,
    windowId: scope === "day" ? null : Number($("#block-window").value),
    capacity: scope === "day" ? 0 : Number($("#block-capacity").value),
    note: $("#block-note").value.trim(),
    acknowledge: state.blockAck,
  };
  if (!payload.date) { toast("Choose a date.", "error"); return; }

  const button = $("#block-submit");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await api("/api/admin/blocks", { method: "POST", body: payload });
    $("#block-dialog").close();
    toast(result.warning || "Availability updated.");
    await loadAvailability();
    if (state.calMonth) loadCalendar(state.calMonth);
  } catch (err) {
    if (err.status === 409 && err.data?.requiresAcknowledgement) {
      $("#block-warning").hidden = false;
      $("#block-warning").textContent = err.data.warning;
      state.blockAck = true;
      button.textContent = "Block anyway";
    } else {
      toast(err.message || "The block could not be saved.", "error");
    }
  } finally {
    button.disabled = false;
    if (button.textContent === "Saving…") button.textContent = "Save block";
  }
}

/* ---------- Setup ---------- */

async function loadSetup() {
  try {
    const origin = encodeURIComponent(location.origin);
    $("#google-connect").href = `/admin/google/start?origin=${origin}`;
    const data = await api(`/api/admin/settings?origin=${origin}`);
    state.setup = data;

    $("#google-redirect").textContent = data.google.redirectUri;
    $("#stripe-webhook-url").textContent = data.stripe.webhookUrl;

    const googleDot = $("#google-dot");
    const googleStatus = $("#google-status");
    if (data.google.connected) {
      googleDot.className = "status-dot ok";
      googleStatus.textContent = `Connected${data.google.accountEmail ? ` as ${data.google.accountEmail}` : ""}`;
      $("#google-connected-box").hidden = false;
      $("#google-account").textContent = data.google.accountEmail || "Google account connected";
      $("#google-calendar-name").textContent = data.google.calendarName;
      $("#google-connect").textContent = "Reconnect Google Calendar";
      loadGoogleCalendars();
    } else if (data.google.clientConfigured) {
      googleDot.className = "status-dot";
      googleStatus.textContent = "Credentials saved — connect your Google account";
      $("#google-connected-box").hidden = true;
      $("#google-connect").textContent = "Connect Google Calendar";
    } else {
      googleDot.className = "status-dot bad";
      googleStatus.textContent = "Owner action needed — add Google OAuth credentials below";
      $("#google-connected-box").hidden = true;
    }

    const stripeDot = $("#stripe-dot");
    const stripeStatus = $("#stripe-status");
    if (data.stripe.configured) {
      stripeDot.className = "status-dot ok";
      stripeStatus.textContent = `Stripe test mode active ${data.stripe.keyTail || ""}${data.stripe.webhookConfigured ? " · webhook configured" : " · webhook not set"}`;
      $("#stripe-demo-note").hidden = true;
      $("#stripe-key-hint").textContent = `A key is saved (${data.stripe.keyTail || "hidden"}). Leave blank to keep it.`;
    } else if (data.stripe.mode === "live") {
      stripeDot.className = "status-dot bad";
      stripeStatus.textContent = "A live key is configured and blocked";
      $("#stripe-demo-note").hidden = true;
      $("#stripe-key-hint").textContent = "Live keys are rejected. Replace it with a test key.";
    } else if (data.stripe.mode === "invalid") {
      stripeDot.className = "status-dot bad";
      stripeStatus.textContent = "The saved key is not a valid test secret key";
      $("#stripe-demo-note").hidden = false;
      $("#stripe-key-hint").textContent = "Use a key beginning sk_test_.";
    } else {
      stripeDot.className = "status-dot";
      stripeStatus.textContent = "Using demo checkout — Stripe not configured";
      $("#stripe-demo-note").hidden = false;
      $("#stripe-key-hint").textContent = "Create a test secret key in the Stripe dashboard.";
    }

    $("#default-password-note").hidden = !data.admin.usingDefaultPassword;
  } catch (err) {
    toast(err.message || "Settings could not be loaded.", "error");
  }
}

async function loadGoogleCalendars() {
  try {
    const data = await api("/api/admin/google/calendars");
    const select = $("#google-calendar-select");
    select.innerHTML = data.calendars.map((calendar) => `
      <option value="${esc(calendar.id)}" ${calendar.id === state.setup?.google.calendarId ? "selected" : ""}>
        ${esc(calendar.name)}${calendar.primary ? " (primary)" : ""}
      </option>`).join("");
  } catch (err) {
    $("#google-calendar-select").innerHTML = `<option value="">${esc(err.message)}</option>`;
  }
}

async function saveGoogleClient(event) {
  event.preventDefault();
  const clientId = $("#google-client-id").value.trim();
  const clientSecret = $("#google-client-secret").value.trim();
  if (!clientId || !clientSecret) {
    toast("Enter both the client ID and client secret.", "error");
    return;
  }
  try {
    await api("/api/admin/settings", { method: "POST", body: { googleClientId: clientId, googleClientSecret: clientSecret } });
    $("#google-client-id").value = "";
    $("#google-client-secret").value = "";
    toast("Google OAuth credentials saved. You can connect now.");
    loadSetup();
  } catch (err) {
    toast(err.message || "The credentials could not be saved.", "error");
  }
}

async function saveCalendarChoice() {
  const calendarId = $("#google-calendar-select").value;
  if (!calendarId) return;
  try {
    await api("/api/admin/google/calendar", { method: "POST", body: { calendarId } });
    toast("Delivery calendar updated.");
    loadSetup();
  } catch (err) {
    toast(err.message || "The calendar could not be changed.", "error");
  }
}

async function testGoogle() {
  const button = $("#google-test");
  button.disabled = true;
  try {
    const result = await api("/api/admin/google/test", { method: "POST" });
    toast(`Calendar write test passed — ${result.calendarName}.`);
  } catch (err) {
    toast(err.message || "The calendar test failed.", "error");
  } finally {
    button.disabled = false;
  }
}

async function disconnectGoogle() {
  if (!confirm("Disconnect Google Calendar? New bookings will not be added until you reconnect.")) return;
  try {
    await api("/api/admin/google/disconnect", { method: "POST" });
    toast("Google Calendar disconnected.");
    loadSetup();
  } catch (err) {
    toast(err.message || "The account could not be disconnected.", "error");
  }
}

async function saveStripe(event) {
  event.preventDefault();
  const secretKey = $("#stripe-key").value.trim();
  const webhookSecret = $("#stripe-webhook").value.trim();
  if (!secretKey && !webhookSecret) {
    toast("Enter a key or webhook secret to save.", "error");
    return;
  }
  try {
    await api("/api/admin/settings", { method: "POST", body: { stripeSecretKey: secretKey, stripeWebhookSecret: webhookSecret } });
    $("#stripe-key").value = "";
    $("#stripe-webhook").value = "";
    toast("Stripe test settings saved.");
    loadSetup();
  } catch (err) {
    toast(err.message || "Stripe settings could not be saved.", "error");
  }
}

async function changePassword(event) {
  event.preventDefault();
  try {
    await api("/api/admin/password", {
      method: "POST",
      body: {
        currentPassword: $("#current-password").value,
        newPassword: $("#new-password").value,
      },
    });
    $("#current-password").value = "";
    $("#new-password").value = "";
    toast("Admin password updated.");
    loadSetup();
  } catch (err) {
    toast(err.message || "The password could not be updated.", "error");
  }
}

init();
