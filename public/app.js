/* All Fired Up — customer ordering flow (test version). */

const STORAGE_KEY = "afu_draft_v2";
const WINDOW_LABELS = ["09:00 – 11:00", "11:00 – 13:00", "13:00 – 15:00", "15:00 – 17:00"];

const state = {
  cart: {},
  customer: {},
  slot: null,
  reservation: null,
};

let boot = null;
let products = new Map();
let availability = null;
let route = "order";
let saving = false;
let countdownTimer = null;
let lastScrollStep = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function money(pence) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(pence) || 0) / 100);
}

function longDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function shortDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty response */ }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code);
  return data;
}

function toast(message, kind = "") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${kind}`.trim();
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.className = "toast"; }, 4200);
}

/* ---------- Draft state ---------- */

function saveDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cart: state.cart,
      customer: state.customer,
      slot: state.slot,
      reservation: state.reservation,
    }));
  } catch { /* private mode */ }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.cart && typeof parsed.cart === "object") state.cart = parsed.cart;
      if (parsed.customer && typeof parsed.customer === "object") state.customer = parsed.customer;
      if (parsed.slot && parsed.slot.date) state.slot = parsed.slot;
      if (parsed.reservation && parsed.reservation.ref) state.reservation = parsed.reservation;
    }
  } catch { /* ignore */ }
}

function clearDraft() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  state.cart = {};
  state.customer = {};
  state.slot = null;
  state.reservation = null;
}

/* ---------- Cart helpers ---------- */

function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ product: products.get(id), qty: Number(qty) }))
    .filter((line) => line.product && line.qty > 0);
}

function cartCount() {
  return cartLines().reduce((sum, line) => sum + line.qty, 0);
}

function hasFirewood() {
  return cartLines().some((line) => ["Logs", "Loose loads", "Nets"].includes(line.product.category));
}

function subtotal() {
  return cartLines().reduce((sum, line) => sum + line.product.price * line.qty, 0);
}

function deliveryFee() {
  if (!boot) return 0;
  return subtotal() >= boot.delivery.freeOverPence ? 0 : boot.delivery.feePence;
}

function orderTotal() {
  return subtotal() + deliveryFee();
}

function cartIssue() {
  const issues = cartLines().filter((line) => line.product.requiresFirewood && !hasFirewood());
  if (!issues.length) return "";
  return `${issues.map((i) => i.product.name).join(" and ")} can only be delivered with a firewood order.`;
}

function postcodeInArea(postcode) {
  if (!boot) return false;
  const clean = String(postcode || "").toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^([A-Z]{1,2})\d/);
  return Boolean(match && boot.business.postcodePrefixes.includes(match[1]));
}

function validPostcode(postcode) {
  const clean = String(postcode || "").trim().toUpperCase().replace(/\s+/g, " ");
  return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(clean);
}

function customerComplete() {
  const c = state.customer;
  return Boolean(
    c.name && c.name.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email || "") &&
    (c.phone || "").replace(/\D/g, "").length >= 7 &&
    (c.address1 || "").trim().length >= 3 &&
    (c.city || "").trim().length >= 2 &&
    validPostcode(c.postcode) && postcodeInArea(c.postcode)
  );
}

/* ---------- Products ---------- */

function renderProducts() {
  const grid = $("#product-grid");
  if (!grid) return;
  grid.innerHTML = boot.products.map((product) => {
    const qty = Number(state.cart[product.id] || 0);
    const blocked = product.requiresFirewood && !hasFirewood() && qty === 0;
    return `
      <article class="product">
        <div class="product-media">
          <img src="${esc(product.image)}" alt="${esc(product.name)}" loading="lazy">
        </div>
        <div class="product-body">
          <div class="product-top">
            <div>
              <h3>${esc(product.name)}</h3>
              <p class="subtitle">${esc(product.subtitle)}</p>
            </div>
            <div class="price">${money(product.price)}<small>${esc(product.unit)}</small></div>
          </div>
          <p class="desc">${esc(product.description)}</p>
          ${product.addonOnly ? `<span class="addon-tag">Add-on</span>` : ""}
          ${product.note ? `<p class="note">${esc(product.note)}</p>` : ""}
          <div class="product-foot">
            <span class="subtitle">${blocked ? "Add logs first" : "Test price"}</span>
            ${qty > 0 ? `
              <div class="stepper" aria-label="Quantity for ${esc(product.name)}">
                <button type="button" data-minus="${esc(product.id)}" aria-label="Remove one">−</button>
                <output>${qty}</output>
                <button type="button" data-add="${esc(product.id)}" aria-label="Add one" ${qty >= product.maxQty ? "disabled" : ""}>+</button>
              </div>` : `
              <button class="add-btn" type="button" data-add="${esc(product.id)}" ${blocked ? "disabled" : ""}>
                ${blocked ? "Add logs first" : "Add"}
              </button>`}
          </div>
        </div>
      </article>`;
  }).join("");
}

function changeQty(id, delta) {
  const product = products.get(id);
  if (!product) return;
  const current = Number(state.cart[id] || 0);
  let next = Math.max(0, Math.min(product.maxQty, current + delta));
  if (delta > 0 && product.requiresFirewood && !hasFirewood()) {
    toast("Add a firewood product first — kindling and coal travel with logs.");
    return;
  }
  if (next === 0) delete state.cart[id];
  else state.cart[id] = next;

  // Removing the last firewood item should not silently keep invalid add-ons.
  if (next === 0 && !hasFirewood()) {
    for (const [cartId, qty] of Object.entries(state.cart)) {
      const p = products.get(cartId);
      if (p?.requiresFirewood) {
        delete state.cart[cartId];
      }
    }
  }
  saveDraft();
  renderProducts();
  renderSummaries();
  renderCartIssue();
  updateMobileBar(route);
}

function renderCartIssue() {
  const el = $("#product-error");
  if (!el) return;
  const issue = cartIssue();
  el.textContent = issue;
  el.hidden = !issue;
}

/* ---------- Summaries ---------- */

function summaryHtml({ showButton }) {
  const lines = cartLines();
  const issue = cartIssue();
  if (!lines.length) {
    return `
      <div class="summary-head"><h2>Your order</h2><span class="test-pill">Test</span></div>
      <div class="summary-body">
        <p class="summary-empty">Nothing added yet. Choose your logs to get started.</p>
        <dl class="summary-total"><dt>Total</dt><dd>£0.00</dd></dl>
        <p class="summary-note">Test prices only. No real payment will be taken.</p>
      </div>
      <div class="summary-foot"><span class="calendar-dot ${boot?.calendar?.connected ? "" : "off"}"></span>${boot?.calendar?.connected ? "Live Google Calendar connected" : "Calendar connection pending"}</div>`;
  }

  const delivery = deliveryFee();
  return `
    <div class="summary-head"><h2>Your order</h2><span class="test-pill">Test</span></div>
    <div class="summary-body">
      ${issue ? `<div class="notice warn" style="font-size:.75rem">${esc(issue)}</div>` : ""}
      ${lines.map((line) => `
        <div class="summary-line">
          <span><span class="qty">${line.qty}×</span>${esc(line.product.name)}</span>
          <span>${money(line.product.price * line.qty)}</span>
        </div>`).join("")}
      <div class="summary-sub">
        <div class="summary-line"><span>Subtotal</span><span>${money(subtotal())}</span></div>
        <div class="summary-line"><span>Delivery${delivery === 0 ? " (free)" : ""}</span><span>${delivery === 0 ? "£0.00" : money(delivery)}</span></div>
      </div>
      <dl class="summary-total"><dt>Total</dt><dd>${money(orderTotal())}</dd></dl>
      <p class="summary-note">Placeholder test prices. Free local delivery on orders over ${money(boot.delivery.freeOverPence)}.</p>
      ${showButton ? `<button class="btn btn-block" id="summary-continue" type="button" ${issue || !lines.length ? "disabled" : ""}>Continue to delivery <span class="arrow">→</span></button>` : ""}
    </div>
    <div class="summary-foot"><span class="calendar-dot ${boot.calendar.connected ? "" : "off"}"></span>${boot.calendar.connected ? "Live calendar: " + esc(boot.calendar.name) : "Calendar connection pending"}</div>`;
}

function renderSummaries() {
  const shop = $("#shop-summary");
  if (shop) shop.innerHTML = summaryHtml({ showButton: true });
  const flow = $("#flow-summary");
  if (flow) flow.innerHTML = summaryHtml({ showButton: false });
  const shopBtn = $("#summary-continue");
  if (shopBtn) {
    shopBtn.addEventListener("click", () => {
      if (!cartLines().length) return;
      if (cartIssue()) { toast(cartIssue()); return; }
      navigate("delivery");
    });
  }
}

/* ---------- Routing & steps ---------- */

const STEP_META = {
  order: { title: "Your order", subtitle: "Build your order, then choose a delivery slot." },
  delivery: { title: "Delivery details", subtitle: "Tell us where the logs are going." },
  slot: { title: "Choose your delivery slot", subtitle: "Two-hour windows, Monday to Friday." },
  review: { title: "Review and pay", subtitle: "One last look before the test payment." },
};

function parseHash() {
  const value = location.hash.replace("#", "");
  return ["order", "delivery", "slot", "review"].includes(value) ? value : "order";
}

function navigate(step) {
  if (parseHash() === step) applyRoute();
  else location.hash = step;
}

function reservationExpired() {
  return Boolean(state.reservation && state.reservation.expiresAt && state.reservation.expiresAt <= Date.now());
}

function resolveRoute() {
  let step = parseHash();
  if (step !== "order" && (!cartLines().length || cartIssue())) step = "order";
  if (step === "slot" && !customerComplete()) step = "delivery";
  if (step === "review") {
    if (!state.reservation) step = "slot";
    else if (reservationExpired()) {
      state.reservation = null;
      saveDraft();
      step = "slot";
      toast("Your 15-minute slot hold expired. Please choose a slot again.", "error");
    }
  }
  return step;
}

function renderStepper(step) {
  const order = ["order", "delivery", "slot", "review"];
  const current = order.indexOf(step);
  $("#steps").innerHTML = order.map((key, index) => {
    const label = ["Your order", "Delivery details", "Delivery slot", "Review & pay"][index];
    const cls = index === current ? "active" : index < current ? "done" : "";
    return `<li class="${cls}"><span class="n">${index < current ? "✓" : index + 1}</span><span class="label">${label}</span></li>`;
  }).join("");
}

function applyRoute({ scroll = false } = {}) {
  const step = resolveRoute();
  route = step;

  if (parseHash() !== step) history.replaceState(null, "", `#${step}`);

  const isFlow = step !== "order";
  document.body.classList.toggle("flow", isFlow);
  $("#shop-view").hidden = isFlow;
  $("#flow-view").hidden = !isFlow;
  $("#flow-head").hidden = !isFlow;

  if (isFlow) {
    $("#flow-title").textContent = STEP_META[step].title;
    $("#flow-subtitle").textContent = STEP_META[step].subtitle;
    renderStepper(step);
    renderStep(step);
    if (scroll && lastScrollStep !== step) {
      lastScrollStep = step;
      $("#order").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } else {
    renderProducts();
    renderCartIssue();
  }

  renderSummaries();
  updateMobileBar(step);
}

function renderStep(step) {
  const container = $("#step-content");
  if (!container) return;
  clearInterval(countdownTimer);

  if (step === "delivery") renderDeliveryStep(container);
  if (step === "slot") renderSlotStep(container);
  if (step === "review") renderReviewStep(container);
}

/* ---------- Step: delivery ---------- */

function renderDeliveryStep(container) {
  const c = state.customer;
  container.innerHTML = `
    <div class="panel">
      <h2>Where shall we deliver?</h2>
      <p class="panel-intro">We deliver Monday to Friday within roughly 20 miles of Dereham. This test version accepts postcodes beginning NR, IP, PE or CB.</p>
      <form id="delivery-form" novalidate>
        <div class="form-grid">
          <div class="field full" data-field="name">
            <label for="name">Full name <span class="req">*</span></label>
            <input id="name" name="name" autocomplete="name" value="${esc(c.name || "")}" placeholder="e.g. Alex Morgan" required>
            <p class="error-text" data-error="name" hidden></p>
          </div>
          <div class="field" data-field="email">
            <label for="email">Email address <span class="req">*</span></label>
            <input id="email" name="email" type="email" autocomplete="email" value="${esc(c.email || "")}" placeholder="you@example.com" required>
            <p class="error-text" data-error="email" hidden></p>
          </div>
          <div class="field" data-field="phone">
            <label for="phone">Phone number <span class="req">*</span></label>
            <input id="phone" name="phone" type="tel" autocomplete="tel" value="${esc(c.phone || "")}" placeholder="07700 900000" required>
            <p class="error-text" data-error="phone" hidden></p>
          </div>
          <div class="field full" data-field="address1">
            <label for="address1">Address line 1 <span class="req">*</span></label>
            <input id="address1" name="address1" autocomplete="address-line1" value="${esc(c.address1 || "")}" placeholder="House name or number and street" required>
            <p class="error-text" data-error="address1" hidden></p>
          </div>
          <div class="field full">
            <label for="address2">Address line 2 <span class="hint">(optional)</span></label>
            <input id="address2" name="address2" autocomplete="address-line2" value="${esc(c.address2 || "")}" placeholder="Village, hamlet or building">
          </div>
          <div class="field" data-field="city">
            <label for="city">Town or city <span class="req">*</span></label>
            <input id="city" name="city" autocomplete="address-level2" value="${esc(c.city || "")}" placeholder="e.g. Dereham" required>
            <p class="error-text" data-error="city" hidden></p>
          </div>
          <div class="field" data-field="postcode">
            <label for="postcode">Postcode <span class="req">*</span></label>
            <div class="postcode-row">
              <input id="postcode" name="postcode" autocomplete="postal-code" value="${esc(c.postcode || "")}" placeholder="NR19 2LA" required>
              <button class="btn btn-outline btn-sm" type="button" id="check-postcode">Check area</button>
            </div>
            <p class="error-text" data-error="postcode" hidden></p>
            <div class="area-message" id="area-message" hidden></div>
          </div>
          <div class="field full">
            <label for="notes">Delivery or access notes <span class="hint">(optional)</span></label>
            <textarea id="notes" name="notes" placeholder="Leave by side gate, narrow drive, call on arrival…" maxlength="600">${esc(c.notes || "")}</textarea>
            <p class="hint">These details are used for this test order and the delivery calendar.</p>
          </div>
        </div>
        <div class="panel-actions">
          <button class="btn btn-outline" type="button" id="delivery-back">← Back to order</button>
          <button class="btn" type="submit">Choose a delivery slot →</button>
        </div>
      </form>
    </div>`;

  const form = $("#delivery-form");
  form.addEventListener("input", (event) => {
    const field = event.target;
    if (!field.name) return;
    state.customer[field.name] = field.value;
    saveDraft();
    if (field.name === "postcode") showAreaMessage(field.value, false);
  });

  $("#check-postcode").addEventListener("click", () => {
    const postcode = $("#postcode").value;
    if (!postcode.trim()) {
      setFieldError("postcode", "Enter your postcode to check the delivery area.");
      return;
    }
    showAreaMessage(postcode, true);
  });

  $("#delivery-back").addEventListener("click", () => navigate("order"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const errors = validateCustomer();
    if (Object.keys(errors).length) {
      const first = Object.keys(errors)[0];
      const el = form.querySelector(`[data-field="${first}"] input, [data-field="${first}"] textarea`);
      el?.focus();
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    state.customer = { ...state.customer };
    saveDraft();
    navigate("slot");
  });

  if (c.postcode) showAreaMessage(c.postcode, false);
}

function setFieldError(name, message) {
  const field = document.querySelector(`[data-field="${name}"]`);
  const error = document.querySelector(`[data-error="${name}"]`);
  if (field) field.classList.toggle("invalid", Boolean(message));
  if (error) {
    error.hidden = !message;
    error.textContent = message || "";
  }
}

function showAreaMessage(postcode, markError) {
  const el = $("#area-message");
  if (!el) return;
  const value = String(postcode || "").trim();
  if (!value) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!validPostcode(value)) {
    el.className = "area-message bad";
    el.textContent = "That does not look like a complete UK postcode. Please check and try again.";
    if (markError) setFieldError("postcode", "Enter a valid UK postcode.");
    return;
  }
  if (!postcodeInArea(value)) {
    el.className = "area-message bad";
    el.textContent = `We do not deliver to ${value.toUpperCase()} in this test version. We cover sample postcodes beginning NR, IP, PE and CB.`;
    if (markError) setFieldError("postcode", "This postcode is outside our sample delivery area.");
    return;
  }
  const prefix = value.toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,2})\d/)?.[1] || "";
  el.className = "area-message ok";
  el.textContent = `Good news — ${prefix} is in our sample delivery area. Final delivery availability will be confirmed after you book.`;
  setFieldError("postcode", "");
}

function validateCustomer() {
  const c = state.customer;
  const errors = {};
  if (!c.name || c.name.trim().length < 2) errors.name = "Please enter the name for the delivery.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email || "")) errors.email = "Please enter a valid email address.";
  const digits = (c.phone || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) errors.phone = "Please enter a valid phone number.";
  if (!c.address1 || c.address1.trim().length < 3) errors.address1 = "Please enter the first line of the address.";
  if (!c.city || c.city.trim().length < 2) errors.city = "Please enter the town or city.";
  if (!validPostcode(c.postcode)) errors.postcode = "Please enter a valid UK postcode.";
  else if (!postcodeInArea(c.postcode)) errors.postcode = "This postcode is outside our sample delivery area (NR, IP, PE, CB).";

  ["name", "email", "phone", "address1", "city", "postcode"].forEach((key) => {
    setFieldError(key, errors[key] || "");
  });
  if (errors.postcode) showAreaMessage(c.postcode, false);
  return errors;
}

/* ---------- Step: slot ---------- */

async function renderSlotStep(container) {
  container.innerHTML = `
    <div class="panel">
      <h2>Choose a delivery window</h2>
      <p class="panel-intro">Deliveries run Monday to Friday. We need at least 24 hours' notice, and each window has two spaces.</p>
      <div style="display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.85rem;padding:10px 0 20px">
        <span class="spinner"></span> Checking live availability…
      </div>
      <div class="panel-actions">
        <button class="btn btn-outline" type="button" id="slot-back">← Back to details</button>
      </div>
    </div>`;

  $("#slot-back").addEventListener("click", () => navigate("delivery"));

  try {
    availability = await api("/api/availability?days=35");
  } catch (err) {
    container.innerHTML = `
      <div class="panel">
        <h2>Choose a delivery window</h2>
        <div class="notice warn">${esc(err.message || "Availability could not be loaded.")}</div>
        <div class="panel-actions">
          <button class="btn btn-outline" type="button" id="slot-back">← Back to details</button>
          <button class="btn" type="button" id="slot-retry">Try again</button>
        </div>
      </div>`;
    $("#slot-back").addEventListener("click", () => navigate("delivery"));
    $("#slot-retry").addEventListener("click", () => renderSlotStep(container));
    return;
  }

  const cal = availability.calendar;
  const banner = cal.status === "connected"
    ? `<div class="calendar-banner"><span class="dot"></span> Live availability checked against the ${esc(cal.name)} calendar.</div>`
    : cal.status === "error"
      ? `<div class="calendar-banner off"><span class="dot"></span> The live calendar could not be checked just now. Availability is shown from our internal schedule — please call if you are unsure.</div>`
      : `<div class="calendar-banner off"><span class="dot"></span> Google Calendar is not connected yet. Availability is shown from the internal delivery schedule for this test.</div>`;

  const days = availability.days;
  const selected = state.slot;

  container.innerHTML = `
    <div class="panel">
      <h2>Choose a delivery window</h2>
      <p class="panel-intro">We need at least 24 hours' notice. Your chosen slot is held for 15 minutes while you pay.</p>
      ${banner}
      <div class="legend">
        <span><i class="av"></i> Available</span>
        <span><i class="fu"></i> Fully booked</span>
        <span><i class="bl"></i> No deliveries</span>
      </div>
      <div class="day-list" id="day-list">
        ${days.length ? days.map((day) => renderDay(day, selected)).join("") : `<p class="summary-empty">No delivery dates are available in the next five weeks. Please call the yard.</p>`}
      </div>
      <div class="panel-actions">
        <button class="btn btn-outline" type="button" id="slot-back">← Back to details</button>
        <button class="btn" type="button" id="slot-continue" ${selected ? "" : "disabled"}>
          ${selected ? "Review order →" : "Select a window →"}
        </button>
      </div>
      <p style="font-size:.73rem;color:var(--muted);margin-top:12px">
        Availability combines paid orders, active 15-minute holds, blocked dates and busy time in our Google delivery calendar.
      </p>
    </div>`;

  $("#slot-back").addEventListener("click", () => navigate("delivery"));
  $("#day-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-slot]");
    if (!button || button.disabled) return;
    const date = button.dataset.date;
    const windowId = Number(button.dataset.window);
    state.slot = { date, windowId, label: button.dataset.label };
    saveDraft();
    for (const el of $$(".slot", $("#day-list"))) {
      const isMatch = el.dataset.date === date && Number(el.dataset.window) === windowId;
      el.classList.toggle("selected", isMatch);
      el.setAttribute("aria-pressed", isMatch ? "true" : "false");
    }
    const continueBtn = $("#slot-continue");
    continueBtn.disabled = false;
    continueBtn.textContent = "Review order →";
  });

  $("#slot-continue").addEventListener("click", async () => {
    if (!state.slot) { toast("Choose a delivery window first."); return; }
    if (saving) return;
    saving = true;
    const button = $("#slot-continue");
    button.disabled = true;
    button.innerHTML = `<span class="spinner" style="border-top-color:#261a09"></span> Holding your slot…`;

    try {
      const payload = {
        items: cartLines().map((line) => ({ id: line.product.id, qty: line.qty })),
        customer: state.customer,
        delivery: { date: state.slot.date, windowId: state.slot.windowId },
      };
      const data = await api("/api/reservations", { method: "POST", body: payload });
      state.reservation = {
        ref: data.ref,
        token: data.token,
        expiresAt: data.expiresAt,
        order: data.order,
      };
      saveDraft();
      navigate("review");
    } catch (err) {
      toast(err.message || "That slot could not be held.", "error");
      if (err.code === "OUT_OF_AREA") {
        navigate("delivery");
      } else {
        await renderSlotStep(container);
      }
    } finally {
      saving = false;
      if (button && button.isConnected) {
        button.disabled = false;
        button.textContent = "Review order →";
      }
    }
  });
}

function renderDay(day, selected) {
  const openWindows = day.windows.filter((w) => w.state === "available").length;
  const meta = day.closed
    ? "Closed"
    : openWindows === 0
      ? `<span class="day-meta full">Fully booked</span>`
      : `<span class="day-meta">${day.booked} of ${availability.rules.maxPerDay} spaces booked</span>`;

  if (day.closed) {
    return `
      <div class="day-card closed">
        <div class="day-head"><strong>${esc(day.label)}</strong><span class="day-meta">Closed</span></div>
        <div class="day-closed">No deliveries available</div>
      </div>`;
  }

  return `
    <div class="day-card">
      <div class="day-head"><strong>${esc(day.label)}</strong>${meta}</div>
      <div class="slot-grid">
        ${day.windows.map((win) => {
          const isSelected = selected && selected.date === day.date && Number(selected.windowId) === win.id;
          let status = "";
          if (win.state === "available") status = `${win.remaining} ${win.remaining === 1 ? "space" : "spaces"} left`;
          else if (win.state === "full" || win.state === "busy") status = "Fully booked";
          else if (win.state === "blocked") status = "Unavailable";
          else status = "Unavailable";
          const disabled = win.state !== "available";
          return `
            <button type="button" class="slot ${win.state} ${isSelected ? "selected" : ""}"
              data-slot data-date="${esc(day.date)}" data-window="${win.id}" data-label="${esc(win.label)}"
              ${disabled ? "disabled" : ""} aria-pressed="${isSelected ? "true" : "false"}">
              <span>${esc(win.label)}</span><span>${esc(status)}</span>
            </button>`;
        }).join("")}
      </div>
    </div>`;
}

/* ---------- Step: review ---------- */

function renderReviewStep(container) {
  const reservation = state.reservation;
  if (!reservation) { navigate("slot"); return; }
  const order = reservation.order;
  const items = order.items || [];

  container.innerHTML = `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">
        <div>
          <h2>Check your order</h2>
          <p class="panel-intro">Delivery to ${esc(order.postcode)}. All prices are test placeholders.</p>
        </div>
        <span class="hold-timer" id="hold-timer">Held for 15:00</span>
      </div>

      <div class="review-grid">
        <div class="review-block" style="margin-top:0">
          <div class="review-block-head"><h3>Your logs</h3><button class="btn-link" type="button" id="edit-products">Edit</button></div>
          <div class="review-list">
            ${items.map((item) => `
              <div class="review-line">
                <span><span class="qty">${item.qty}×</span> ${esc(item.name)}</span>
                <strong>${money(item.linePence)}</strong>
              </div>`).join("")}
          </div>
          <div class="totals">
            <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
            <div><span>Delivery</span><span>${order.delivery === 0 ? "Free" : money(order.delivery)}</span></div>
            <div class="grand"><span>Total</span><span>${money(order.total)}</span></div>
          </div>
        </div>

        <div class="review-block" style="margin-top:0">
          <div class="review-block-head"><h3>Delivery details</h3><button class="btn-link" type="button" id="edit-details">Edit</button></div>
          <p><strong>${esc(order.customerName)}</strong></p>
          <p>${esc(order.address)}</p>
          <p>${esc(order.postcode)}</p>
          <p style="margin-top:8px">${esc(order.phone)} · ${esc(order.email)}</p>
          ${order.notes ? `<p style="margin-top:8px"><em>Notes: ${esc(order.notes)}</em></p>` : ""}
        </div>
      </div>

      <div class="review-block">
        <div class="review-block-head">
          <h3>Delivery window</h3>
          <button class="btn-link" type="button" id="edit-slot">Change</button>
        </div>
        <p><strong>${longDate(order.deliveryDate)}</strong>, ${esc(order.deliveryWindow)}</p>
        <p style="font-size:.78rem;color:var(--muted);margin-top:3px">We will confirm the exact arrival by phone if needed.</p>
      </div>

      <div class="pay-banner">
        <h3>Test payment only</h3>
        <p>This uses Stripe Checkout in test mode. No real money is taken and no card details are stored by this app.</p>
        <span class="test-card">Test card: 4242 4242 4242 4242 · any future expiry · any CVC</span>
      </div>

      <div class="panel-actions">
        <button class="btn btn-outline" type="button" id="review-back">← Change slot</button>
        <button class="btn btn-green" type="button" id="pay-now">
          Pay ${money(order.total)} ${boot.stripe.configured ? "with Stripe" : "(demo)"} →
        </button>
      </div>
      <p style="font-size:.73rem;color:var(--muted);margin-top:12px">
        ${boot.stripe.configured
          ? "You will be redirected to Stripe's secure test checkout. For testing, use card 4242 4242 4242 4242."
          : "Stripe test keys are not configured yet, so the demo checkout will be used. The order and calendar booking still work."}
      </p>
    </div>`;

  startCountdown(reservation.expiresAt);
  $("#edit-products").addEventListener("click", () => releaseAndGo("order"));
  $("#edit-details").addEventListener("click", () => releaseAndGo("delivery"));
  $("#edit-slot").addEventListener("click", () => releaseAndGo("slot"));
  $("#review-back").addEventListener("click", () => releaseAndGo("slot"));

  $("#pay-now").addEventListener("click", async () => {
    if (socketExpired()) return;
    if (saving) return;
    saving = true;
    const button = $("#pay-now");
    button.disabled = true;
    button.innerHTML = `<span class="spinner" style="border-top-color:#f6f1e5"></span> Opening secure checkout…`;
    try {
      const data = await api("/api/checkout/session", {
        method: "POST",
        body: { ref: reservation.ref, token: reservation.token, returnOrigin: location.origin },
      });
      if (!data.url) throw new Error("Checkout could not be started.");
      window.location.href = data.url;
    } catch (err) {
      toast(err.message || "Checkout could not be started.", "error");
      button.disabled = false;
      button.textContent = `Pay ${money(order.total)} →`;
      if (err.code === "EXPIRED") {
        state.reservation = null;
        saveDraft();
        navigate("slot");
      }
    } finally {
      saving = false;
    }
  });
}

function socketExpired() {
  return reservationExpired();
}

function startCountdown(expiresAt) {
  clearInterval(countdownTimer);
  const el = $("#hold-timer");
  if (!el || !expiresAt) return;

  const tick = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      el.className = "hold-timer expired";
      el.textContent = "Hold expired";
      const pay = $("#pay-now");
      if (pay) {
        pay.disabled = true;
        pay.textContent = "Slot hold expired";
      }
      clearInterval(countdownTimer);
      toast("Your 15-minute hold has expired. Please choose a slot again.", "error");
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.textContent = `Held for ${mins}:${String(secs).padStart(2, "0")}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function releaseAndGo(step) {
  const reservation = state.reservation;
  if (reservation) {
    try {
      await api("/api/reservations/release", {
        method: "POST",
        body: { ref: reservation.ref, token: reservation.token },
      });
    } catch { /* it may already have expired */ }
  }
  state.reservation = null;
  saveDraft();
  navigate(step);
}

/* ---------- Mobile bar ---------- */

function updateMobileBar(step) {
  const bar = $("#mobile-bar");
  if (!bar) return;
  bar.hidden = step === "review";
  const total = money(orderTotal());
  $("#mobile-total").textContent = total;
  const action = $("#mobile-action");

  if (step === "order") {
    const blocked = !cartLines().length || Boolean(cartIssue());
    $("#mobile-label").textContent = "Order total";
    action.textContent = "Continue";
    action.disabled = blocked;
    return;
  }
  action.disabled = false;

  if (step === "delivery") {
    $("#mobile-label").textContent = "Delivery details";
    $("#mobile-action").textContent = "Choose a slot";
  } else if (step === "slot") {
    $("#mobile-label").textContent = "Order total";
    $("#mobile-action").textContent = state.slot ? "Review order" : "Select a slot";
  }
}

function mobileAction() {
  if (route === "order") {
    if (!cartLines().length) { toast("Add something to your order first."); return; }
    if (cartIssue()) { toast(cartIssue()); return; }
    navigate("delivery");
    return;
  }
  if (route === "delivery") {
    $("#delivery-form")?.requestSubmit();
  } else if (route === "slot") {
    if (!state.slot) {
      $("#day-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast("Choose a delivery window first.");
      return;
    }
    $("#slot-continue")?.click();
  }
}

/* ---------- Boot ---------- */

async function init() {
  $("#year").textContent = String(new Date().getFullYear());
  loadDraft();

  try {
    boot = await api("/api/bootstrap");
  } catch (err) {
    $("#product-grid").innerHTML = `
      <div class="notice warn">The shop could not load: ${esc(err.message)}</div>
      <button class="btn" type="button" id="boot-retry">Try again</button>`;
    $("#boot-retry")?.addEventListener("click", () => location.reload());
    return;
  }

  products = new Map(boot.products.map((product) => [product.id, product]));

  // Drop products that no longer exist from an old draft.
  for (const id of Object.keys(state.cart)) {
    if (!products.has(id)) delete state.cart[id];
  }

  $("#product-grid").addEventListener("click", (event) => {
    const add = event.target.closest("[data-add]");
    const minus = event.target.closest("[data-minus]");
    if (add) changeQty(add.dataset.add, 1);
    if (minus) changeQty(minus.dataset.minus, -1);
  });

  $("#mobile-action").addEventListener("click", mobileAction);

  const params = new URLSearchParams(location.search);
  if (params.get("canceled") === "1" && state.reservation) {
    toast("Payment cancelled. Your slot is still held until the timer runs out.", "error");
    history.replaceState(null, "", "#review");
  }

  renderProducts();
  renderSummaries();
  renderCartIssue();
  applyRoute();

  window.addEventListener("hashchange", () => applyRoute({ scroll: true }));
}

init();
