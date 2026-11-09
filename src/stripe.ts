import type { D1Database } from "@cloudflare/workers-types";
import { getSettings, type Env, type OrderRow } from "./db";
import { formatMoney } from "./google";

const API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "StripeError";
    this.status = status;
  }
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  mode: "test" | "live" | "invalid" | "none";
  configured: boolean;
  webhookConfigured: boolean;
}

export async function stripeConfig(env: Env, db: D1Database): Promise<StripeConfig> {
  const s = await getSettings(db, ["stripe_secret_key", "stripe_webhook_secret"]);
  const secretKey = env.STRIPE_SECRET_KEY || s.stripe_secret_key || "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || s.stripe_webhook_secret || "";
  const mode = secretKey.startsWith("sk_test_")
    ? "test"
    : secretKey.startsWith("sk_live_")
      ? "live"
      : secretKey
        ? "invalid"
        : "none";
  return {
    secretKey,
    webhookSecret,
    mode,
    configured: mode === "test",
    webhookConfigured: Boolean(webhookSecret),
  };
}

function assertTestKey(cfg: StripeConfig): void {
  if (cfg.mode === "live") {
    throw new StripeError(
      "A live Stripe key has been entered. This app only accepts test-mode keys beginning sk_test_.",
      400,
    );
  }
  if (cfg.mode !== "test") {
    throw new StripeError("Stripe test keys are not configured yet.", 400);
  }
}

async function stripeFetch<T>(
  env: Env,
  db: D1Database,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const cfg = await stripeConfig(env, db);
  assertTestKey(cfg);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new StripeError(data?.error?.message || `Stripe returned ${res.status}.`, res.status);
  }
  return data as T;
}

export interface CheckoutSession {
  id: string;
  url: string;
  payment_status?: string;
  amount_total?: number;
  payment_intent?: string | { id?: string } | null;
  metadata?: Record<string, string>;
}

export async function createCheckoutSession(
  env: Env,
  db: D1Database,
  order: OrderRow,
  items: { name: string; qty: number; unit_pence: number }[],
  urls: { success: string; cancel: string },
): Promise<CheckoutSession> {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", urls.success);
  params.set("cancel_url", urls.cancel);
  params.set("customer_email", order.email);
  params.set("client_reference_id", order.ref);
  params.set("billing_address_collection", "auto");
  params.set("submit_type", "pay");
  params.set("metadata[order_id]", order.id);
  params.set("metadata[order_ref]", order.ref);
  params.set("payment_intent_data[metadata][order_id]", order.id);
  params.set("payment_intent_data[description]", `All Fired Up test order ${order.ref}`);
  // Stripe requires at least 30 minutes; allow a little clock margin.
  params.set("expires_at", String(Math.floor(Date.now() / 1000) + 31 * 60));

  items.forEach((item, index) => {
    params.set(`line_items[${index}][quantity]`, String(item.qty));
    params.set(`line_items[${index}][price_data][currency]`, "gbp");
    params.set(`line_items[${index}][price_data][unit_amount]`, String(item.unit_pence));
    params.set(`line_items[${index}][price_data][product_data][name]`, item.name);
  });
  if (order.delivery_pence > 0) {
    const i = items.length;
    params.set(`line_items[${i}][quantity]`, "1");
    params.set(`line_items[${i}][price_data][currency]`, "gbp");
    params.set(`line_items[${i}][price_data][unit_amount]`, String(order.delivery_pence));
    params.set(
      `line_items[${i}][price_data][product_data][name]`,
      "Local delivery (test price)",
    );
  }

  const data = await stripeFetch<{ id: string; url: string }>(env, db, "/checkout/sessions", {
    method: "POST",
    body: params.toString(),
  });
  if (!data.id || !data.url) throw new StripeError("Stripe did not return a checkout URL.", 502);
  return data;
}

export async function retrieveCheckoutSession(
  env: Env,
  db: D1Database,
  sessionId: string,
): Promise<CheckoutSession> {
  const params = new URLSearchParams({ "expand[]": "payment_intent" });
  return stripeFetch<CheckoutSession>(
    env,
    db,
    `/checkout/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`,
    { method: "GET" },
  );
}

export function paymentIntentId(session: CheckoutSession): string {
  if (!session.payment_intent) return "";
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id ?? "";
}

/** Verify a Stripe webhook signature without the Stripe SDK (Web Crypto only). */
export async function verifyStripeWebhook(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export function stripeSummary(order: OrderRow): string {
  return `${order.ref} · ${formatMoney(order.total_pence)}`;
}
