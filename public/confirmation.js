const params = new URLSearchParams(location.search);
const ref = params.get("ref") || "";
const token = params.get("token") || "";
const sessionId = params.get("session_id") || "";

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function money(pence) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(pence) || 0) / 100);
}

function longDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function showError(message) {
  $("#loading-card").hidden = true;
  $("#result-card").hidden = true;
  $("#error-card").hidden = false;
  $("#error-message").textContent = message;
}

function render(order) {
  $("#loading-card").hidden = true;
  $("#error-card").hidden = true;
  $("#result-card").hidden = false;

  const paid = order.paymentStatus === "paid";
  $("#result-icon").textContent = paid ? "✓" : "…";
  $("#result-icon").style.background = paid ? "var(--green)" : "#b08a4a";
  $("#result-title").textContent = paid ? "You're all fired up" : "Payment is confirming";
  $("#result-subtitle").textContent = paid
    ? `Thanks ${order.customerName.split(" ")[0]} — your delivery is booked.`
    : "We are waiting for Stripe to confirm the test payment.";
  $("#result-ref").textContent = order.ref;

  const calendarLine = order.calendarSynced
    ? `<div class="confirm-status ok">✓ Added to the <strong>All Fired Up Deliveries</strong> Google Calendar as a busy delivery.</div>`
    : order.calendarError
      ? `<div class="confirm-status warn">Payment confirmed. The calendar entry is pending — the team can add it from the owner dashboard.</div>`
      : `<div class="confirm-status warn">Payment confirmed. The calendar entry is being prepared.</div>`;

  const emailLine = `<div class="confirm-status warn" style="background:var(--cream);color:#6b5b46">Simulated confirmation email to <strong>${esc(order.email)}</strong>. No real email is sent in this test version.</div>`;

  $("#result-body").innerHTML = `
    <div class="notice info" style="margin-bottom:0">
      <strong>Test order — no real payment was taken.</strong> This booking is stored separately as test data.
    </div>

    ${paid ? `
      <div class="confirm-slot">
        <div class="box"><small>Delivery date</small><strong>${longDate(order.deliveryDate)}</strong></div>
        <div class="box"><small>Time window</small><strong>${esc(order.deliveryWindow)}</strong></div>
      </div>
      ${calendarLine}
    ` : `
      <div class="confirm-status warn"><span class="spinner"></span> Checking the Stripe test payment — this page will update automatically.</div>
    `}

    <div style="margin-top:22px">
      <h3 style="font-family:var(--serif);font-size:1.2rem;margin-bottom:8px">Your order</h3>
      <div class="review-list">
        ${order.items.map((item) => `
          <div class="review-line"><span><span class="qty">${item.qty}×</span> ${esc(item.name)}</span><strong>${money(item.linePence)}</strong></div>
        `).join("")}
      </div>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
        <div><span>Delivery</span><span>${order.delivery === 0 ? "Free" : money(order.delivery)}</span></div>
        <div class="grand"><span>Total — test payment</span><span>${money(order.total)}</span></div>
      </div>
    </div>

    <div class="review-grid" style="margin-top:18px">
      <div class="detail-block">
        <h4>Delivering to</h4>
        <p><strong>${esc(order.customerName)}</strong><br>${esc(order.address)}<br>${esc(order.postcode)}</p>
        <p style="margin-top:7px;font-size:.78rem;color:var(--muted)">${esc(order.phone)}<br>${esc(order.email)}</p>
      </div>
      <div class="detail-block">
        <h4>Payment</h4>
        <p>${paid ? "Paid with Stripe test mode" : "Awaiting confirmation"}</p>
        <p style="margin-top:7px;font-size:.78rem;color:var(--muted)">Reference ${esc(order.ref)}<br>${esc(order.deliveryWindow)}</p>
      </div>
    </div>

    ${order.notes ? `<div class="detail-block" style="margin-top:14px"><h4>Delivery notes</h4><p>${esc(order.notes)}</p></div>` : ""}

    ${emailLine}

    <div class="confirm-actions">
      <a class="btn" href="/">Place another test order</a>
      <a class="btn btn-outline" href="/admin">Open owner dashboard</a>
    </div>
    <p style="font-size:.72rem;color:var(--muted);margin-top:16px">
      Keep your order reference. This test version does not send real emails or take real payments.
    </p>
  `;

  if (paid) {
    try { localStorage.removeItem("afu_draft_v2"); } catch { /* ignore */ }
  } else if (sessionId) {
    // The webhook may arrive shortly; refresh the order a few times.
    poll(order, 0);
  }
}

let pollAttempts = 0;
async function poll(order, attempt) {
  if (order.paymentStatus === "paid") return;
  if (attempt > 12) {
    const status = $("#result-body").querySelector(".confirm-status.warn");
    if (status) {
      status.innerHTML = `Payment confirmation is taking longer than expected. <button class="btn-link" type="button" id="refresh-status">Refresh status</button>`;
      status.scrollIntoView({ block: "nearest" });
      $("#refresh-status")?.addEventListener("click", () => location.reload());
    }
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    await api(`/api/orders/${encodeURIComponent(ref)}/sync`, {
      method: "POST",
      body: { token, session_id: sessionId },
    });
    const data = await api(`/api/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`);
    if (data.order.paymentStatus === "paid") {
      render(data.order);
      return;
    }
    poll(data.order, attempt + 1);
  } catch {
    poll(order, attempt + 1);
  }
}

async function load() {
  if (!ref || !token) {
    showError("This confirmation link is missing its order reference or access token.");
    return;
  }
  try {
    if (sessionId) {
      try {
        await api(`/api/orders/${encodeURIComponent(ref)}/sync`, {
          method: "POST",
          body: { token, session_id: sessionId },
        });
      } catch (err) {
        // The webhook may still confirm; the normal lookup below can show paid.
      }
    }
    const data = await api(`/api/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`);
    render(data.order);
  } catch (err) {
    showError(err.message || "We could not find this order.");
  }
}

load();
