const params = new URLSearchParams(location.search);
const ref = params.get("ref") || "";
const token = params.get("token") || "";

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

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast show error";
  setTimeout(() => { el.className = "toast"; }, 5000);
}

async function init() {
  if (!ref || !token) {
    toast("This demo payment link is incomplete.");
    return;
  }
  $("#demo-ref").textContent = ref;

  try {
    const data = await api(`/api/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`);
    const order = data.order;
    if (order.paymentStatus === "paid") {
      location.replace(`/confirmation?ref=${encodeURIComponent(ref)}&token=${encodeURIComponent(token)}`);
      return;
    }
    $("#demo-summary").innerHTML = `
      <div class="review-block">
        <div class="review-block-head"><h3>Your order</h3><strong>${money(order.total)}</strong></div>
        <p>${order.items.map((i) => `${i.qty} × ${esc(i.name)}`).join("<br>")}</p>
        <div class="totals" style="margin-top:12px">
          <div><span>Date</span><span>${longDate(order.deliveryDate)}</span></div>
          <div class="grand"><span>Total</span><span>${money(order.total)}</span></div>
        </div>
      </div>`;
  } catch (err) {
    toast(err.message || "This order could not be loaded.");
    $("#demo-pay").disabled = true;
  }

  $("#demo-pay").addEventListener("click", async () => {
    const button = $("#demo-pay");
    button.disabled = true;
    button.innerHTML = `<span class="spinner" style="border-top-color:#f6f1e5"></span> Confirming test order…`;
    try {
      await api("/api/demo/confirm", { method: "POST", body: { ref, token } });
      location.href = `/confirmation?ref=${encodeURIComponent(ref)}&token=${encodeURIComponent(token)}`;
    } catch (err) {
      toast(err.message || "The demo payment could not be completed.");
      button.disabled = false;
      button.textContent = "Pay and confirm test order";
    }
  });
}

init();
