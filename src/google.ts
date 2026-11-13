import type { D1Database } from "@cloudflare/workers-types";
import { BUSINESS, getSettings, setSetting, type BlockRow, type Env, type OrderRow } from "./db";
import { addDays, bandById, londonToUtc, windowById } from "./time";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  GMAIL_SEND_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
];
const SCOPE = SCOPES.join(" ");
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessExpires: number;
  calendarId: string;
  calendarName: string;
  accountEmail: string;
}

export async function googleConfig(env: Env, db: D1Database): Promise<GoogleConfig> {
  const s = await getSettings(db, [
    "google_client_id",
    "google_client_secret",
    "google_refresh_token",
    "google_access_token",
    "google_access_expires",
    "google_calendar_id",
    "google_calendar_name",
    "google_account_email",
  ]);
  return {
    clientId: s.google_client_id || env.GOOGLE_CLIENT_ID || "",
    clientSecret: s.google_client_secret || env.GOOGLE_CLIENT_SECRET || "",
    refreshToken: s.google_refresh_token || "",
    accessToken: s.google_access_token || "",
    accessExpires: Number(s.google_access_expires || 0),
    calendarId: s.google_calendar_id || BUSINESS.defaultCalendarId,
    calendarName: s.google_calendar_name || BUSINESS.defaultCalendarName,
    accountEmail: s.google_account_email || "",
  };
}

export function redirectUri(origin: string): string {
  return `${origin}/admin/google/callback`;
}

export async function googleAuthUrl(env: Env, db: D1Database, origin: string, state: string) {
  const cfg = await googleConfig(env, db);
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new GoogleError("Add your Google OAuth client ID and secret first.", 400);
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(
  env: Env,
  db: D1Database,
  code: string,
  redirect: string,
): Promise<void> {
  const cfg = await googleConfig(env, db);
  if (!cfg.clientId || !cfg.clientSecret) throw new GoogleError("Google OAuth is not configured.", 400);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new GoogleError(data.error_description || data.error || "Google sign-in could not be completed.", 400);
  }
  await setSetting(db, "google_access_token", data.access_token);
  await setSetting(db, "google_access_expires", String(Date.now() + (data.expires_in ?? 3600) * 1000));
  if (data.refresh_token) await setSetting(db, "google_refresh_token", data.refresh_token);
  if (data.scope) await setSetting(db, "google_scopes", data.scope);

  try {
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { email?: string };
      if (info.email) await setSetting(db, "google_account_email", info.email);
    }
  } catch {
    // The connection still works without the display email.
  }
}

async function accessToken(env: Env, db: D1Database, force = false): Promise<string> {
  const cfg = await googleConfig(env, db);
  if (!force && cfg.accessToken && cfg.accessExpires > Date.now() + 60_000) return cfg.accessToken;
  if (!cfg.refreshToken) throw new GoogleError("Google Calendar is not connected yet.", 400);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new GoogleError(
      data.error_description || "The Google Calendar connection has expired. Please reconnect.",
      401,
    );
  }
  await setSetting(db, "google_access_token", data.access_token);
  await setSetting(db, "google_access_expires", String(Date.now() + (data.expires_in ?? 3600) * 1000));
  if (data.refresh_token) await setSetting(db, "google_refresh_token", data.refresh_token);
  return data.access_token;
}

async function gfetch(
  env: Env,
  db: D1Database,
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<Response> {
  const token = await accessToken(env, db);
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401 && retry) {
    await accessToken(env, db, true);
    return gfetch(env, db, path, init, false);
  }
  if (!res.ok) {
    let message = `Google Calendar returned ${res.status}.`;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      // keep the status message
    }
    throw new GoogleError(message, res.status);
  }
  return res;
}

export interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

export async function listGoogleCalendars(env: Env, db: D1Database): Promise<GoogleCalendar[]> {
  const res = await gfetch(
    env,
    db,
    "/users/me/calendarList?minAccessRole=writer&maxResults=250&showHidden=true",
  );
  const data = (await res.json()) as { items?: GoogleCalendar[] };
  return (data.items ?? []).filter((c) => c.id && c.summary);
}

export async function getCalendar(env: Env, db: D1Database, id: string): Promise<GoogleCalendar> {
  const res = await gfetch(env, db, `/calendars/${encodeURIComponent(id)}`);
  const data = (await res.json()) as { id?: string; summary?: string; timeZone?: string };
  if (!data.id) throw new GoogleError("Calendar not found.", 404);
  return { id: data.id, summary: data.summary ?? "Calendar", timeZone: data.timeZone };
}

/** Find the configured delivery calendar, fall back to matching by name, then create it. */
export async function resolveDeliveryCalendar(
  env: Env,
  db: D1Database,
): Promise<{ id: string; name: string; created: boolean }> {
  const cfg = await googleConfig(env, db);
  if (cfg.calendarId) {
    try {
      const cal = await getCalendar(env, db, cfg.calendarId);
      await setSetting(db, "google_calendar_id", cal.id);
      await setSetting(db, "google_calendar_name", cal.summary);
      return { id: cal.id, name: cal.summary, created: false };
    } catch (err) {
      if (!(err instanceof GoogleError) || (err.status !== 404 && err.status !== 403)) throw err;
    }
  }

  const calendars = await listGoogleCalendars(env, db);
  const name = cfg.calendarName || BUSINESS.defaultCalendarName;
  const match = calendars.find((c) => c.summary.trim().toLowerCase() === name.trim().toLowerCase());
  if (match) {
    await setSetting(db, "google_calendar_id", match.id);
    return { id: match.id, name: match.summary, created: false };
  }

  const res = await gfetch(env, db, "/calendars", {
    method: "POST",
    body: JSON.stringify({
      summary: name,
      timeZone: "Europe/London",
      description:
        "Delivery schedule for the All Fired Up firewood ordering app. Bookings and blocked days are managed automatically.",
    }),
  });
  const created = (await res.json()) as { id?: string; summary?: string };
  if (!created.id) throw new GoogleError("Google did not return a calendar ID.", 500);
  await setSetting(db, "google_calendar_id", created.id);
  await setSetting(db, "google_calendar_name", created.summary ?? name);
  return { id: created.id, name: created.summary ?? name, created: true };
}

export function formatMoney(pence: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

export interface BusyInterval {
  start: number;
  end: number;
  summary: string;
}

function eventStart(event: any): number | null {
  if (event.start?.dateTime) {
    const t = Date.parse(event.start.dateTime);
    return Number.isFinite(t) ? t : null;
  }
  if (event.start?.date) return londonToUtc(event.start.date, "00:00").getTime();
  return null;
}

function eventEnd(event: any): number | null {
  if (event.end?.dateTime) {
    const t = Date.parse(event.end.dateTime);
    return Number.isFinite(t) ? t : null;
  }
  if (event.end?.date) return londonToUtc(event.end.date, "00:00").getTime();
  return null;
}

/** Busy intervals from Google Calendar, excluding this app's own delivery bookings (counted in the database). */
export async function fetchGoogleBusy(
  env: Env,
  db: D1Database,
  fromIso: string,
  toIso: string,
): Promise<BusyInterval[]> {
  const cfg = await googleConfig(env, db);
  if (!cfg.calendarId) return [];
  const params = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500",
    showDeleted: "false",
    timeZone: "Europe/London",
  });
  const res = await gfetch(
    env,
    db,
    `/calendars/${encodeURIComponent(cfg.calendarId)}/events?${params.toString()}`,
  );
  const data = (await res.json()) as { items?: any[] };
  const out: BusyInterval[] = [];
  for (const event of data.items ?? []) {
    if (event.status === "cancelled") continue;
    if (event.transparency === "transparent") continue;
    const source = event.extendedProperties?.private?.source;
    if (source === "all-fired-up") continue;
    const start = eventStart(event);
    const end = eventEnd(event);
    if (start === null || end === null || end <= start) continue;
    out.push({ start, end, summary: event.summary ?? "Busy" });
  }
  return out;
}

export interface CalendarBusyResult {
  status: "connected" | "not_connected" | "error";
  intervals: BusyInterval[];
  error?: string;
  calendarName: string;
}

export async function calendarBusy(
  env: Env,
  db: D1Database,
  fromIso: string,
  toIso: string,
  force = false,
): Promise<CalendarBusyResult> {
  const cfg = await googleConfig(env, db);
  const calendarName = cfg.calendarName || BUSINESS.defaultCalendarName;
  if (!cfg.refreshToken) return { status: "not_connected", intervals: [], calendarName };

  if (!force) {
    try {
      const cached = JSON.parse((await getSettings(db, ["google_busy_cache"])).google_busy_cache || "null") as {
        at: number;
        from: number;
        to: number;
        intervals: BusyInterval[];
        calendarId: string;
      } | null;
      if (
        cached &&
        Date.now() - cached.at < 90_000 &&
        cached.from <= Date.parse(fromIso) &&
        cached.to >= Date.parse(toIso) &&
        cached.calendarId === cfg.calendarId
      ) {
        return { status: "connected", intervals: cached.intervals, calendarName };
      }
    } catch {
      // ignore a corrupt cache
    }
  }

  try {
    const intervals = await fetchGoogleBusy(env, db, fromIso, toIso);
    await setSetting(
      db,
      "google_busy_cache",
      JSON.stringify({
        at: Date.now(),
        from: Date.parse(fromIso),
        to: Date.parse(toIso),
        intervals,
        calendarId: cfg.calendarId,
      }),
    );
    return { status: "connected", intervals, calendarName };
  } catch (err) {
    return {
      status: "error",
      intervals: [],
      error: err instanceof Error ? err.message : "Calendar could not be read.",
      calendarName,
    };
  }
}

export async function clearBusyCache(db: D1Database): Promise<void> {
  await setSetting(db, "google_busy_cache", "");
}

export async function createDeliveryEvent(
  env: Env,
  db: D1Database,
  order: OrderRow,
  items: { name: string; qty: number }[],
  summary: string,
): Promise<{ id: string; link: string }> {
  const cfg = await googleConfig(env, db);
  if (!cfg.refreshToken) throw new GoogleError("Google Calendar is not connected.", 400);
  const band = bandById(order.band);
  const win = band ? null : windowById(order.window_id);
  if (!band && !win) throw new GoogleError("Unknown delivery window.", 400);
  const startTime = band ? band.start : win!.start;
  const endTime = band ? band.end : win!.end;

  const description = [
    `Customer: ${order.customer_name}`,
    `Phone: ${order.phone}`,
    `Email: ${order.email}`,
    `Delivery address: ${[order.address1, order.address2, order.city].filter(Boolean).join(", ")}`,
    `Postcode: ${order.postcode}`,
    `Order contents: ${items.map((i) => `${i.qty} × ${i.name}`).join(", ")}`,
    `Delivery notes: ${order.notes || "None"}`,
    `Order total: ${formatMoney(order.total_pence)}`,
    `Payment status: Paid — Stripe test mode`,
    `Order ID: ${order.ref}`,
    "",
    "Test booking created automatically by the All Fired Up ordering app. No real payment was taken.",
  ].join("\n");

  const body = {
    summary: `Delivery: ${order.customer_name} — ${summary}`,
    description,
    start: { dateTime: `${order.delivery_date}T${startTime}:00`, timeZone: "Europe/London" },
    end: { dateTime: `${order.delivery_date}T${endTime}:00`, timeZone: "Europe/London" },
    transparency: "opaque",
    status: "confirmed",
    colorId: "6",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    extendedProperties: {
      private: { source: "all-fired-up", order_id: order.id, order_ref: order.ref },
    },
  };

  const res = await gfetch(env, db, `/calendars/${encodeURIComponent(cfg.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { id?: string; htmlLink?: string };
  if (!data.id) throw new GoogleError("Google did not return an event ID.", 500);
  await clearBusyCache(db);
  return { id: data.id, link: data.htmlLink ?? "" };
}

export async function createBlockEvent(
  env: Env,
  db: D1Database,
  block: BlockRow,
): Promise<{ id: string; link: string }> {
  const cfg = await googleConfig(env, db);
  if (!cfg.refreshToken) throw new GoogleError("Google Calendar is not connected.", 400);

  const blockBand = bandById(block.band);
  const body = blockBand
    ? {
        summary: "Blocked — no deliveries",
        description: `${block.note ? block.note + "\n\n" : ""}${blockBand.short} round closed in the All Fired Up admin.`,
        start: { dateTime: `${block.date}T${blockBand.start}:00`, timeZone: "Europe/London" },
        end: { dateTime: `${block.date}T${blockBand.end}:00`, timeZone: "Europe/London" },
        transparency: "opaque",
        status: "confirmed",
        colorId: "8",
        extendedProperties: { private: { source: "all-fired-up-block", block_id: block.id } },
      }
    : block.window_id === null
      ? {
          summary: "Blocked — no deliveries",
          description: `${block.note ? block.note + "\n\n" : ""}Whole day closed in the All Fired Up admin.`,
          start: { date: block.date },
          end: { date: addDays(block.date, 1) },
          transparency: "opaque",
          status: "confirmed",
          colorId: "8",
          extendedProperties: { private: { source: "all-fired-up-block", block_id: block.id } },
        }
      : (() => {
          const win = windowById(block.window_id);
          if (!win) throw new GoogleError("Unknown delivery window.", 400);
          return {
            summary: "Blocked — no deliveries",
            description: `${block.note ? block.note + "\n\n" : ""}Delivery window closed in the All Fired Up admin.`,
            start: { dateTime: `${block.date}T${win.start}:00`, timeZone: "Europe/London" },
            end: { dateTime: `${block.date}T${win.end}:00`, timeZone: "Europe/London" },
            transparency: "opaque",
            status: "confirmed",
            colorId: "8",
            extendedProperties: { private: { source: "all-fired-up-block", block_id: block.id } },
          };
        })();

  const res = await gfetch(env, db, `/calendars/${encodeURIComponent(cfg.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { id?: string; htmlLink?: string };
  if (!data.id) throw new GoogleError("Google did not return an event ID.", 500);
  await clearBusyCache(db);
  return { id: data.id, link: data.htmlLink ?? "" };
}

export async function deleteCalendarEvent(env: Env, db: D1Database, eventId: string): Promise<void> {
  const cfg = await googleConfig(env, db);
  if (!cfg.refreshToken || !eventId) return;
  try {
    await gfetch(env, db, `/calendars/${encodeURIComponent(cfg.calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (err instanceof GoogleError && err.status === 404) return;
    throw err;
  } finally {
    await clearBusyCache(db);
  }
}

export async function testCalendarAccess(env: Env, db: D1Database): Promise<{ ok: true; calendarName: string }> {
  const cal = await resolveDeliveryCalendar(env, db);
  const res = await gfetch(env, db, `/calendars/${encodeURIComponent(cal.id)}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: "All Fired Up connection test — safe to delete",
      description: "This temporary event was created by the All Fired Up test app to check calendar write access.",
      start: { dateTime: new Date(Date.now() + 30 * 60_000).toISOString(), timeZone: "UTC" },
      end: { dateTime: new Date(Date.now() + 45 * 60_000).toISOString(), timeZone: "UTC" },
      transparency: "transparent",
      extendedProperties: { private: { source: "all-fired-up-test" } },
    }),
  });
  const data = (await res.json()) as { id?: string };
  if (data.id) {
    try {
      await gfetch(env, db, `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(data.id)}`, {
        method: "DELETE",
      });
    } catch {
      // A leftover test event is harmless and clearly labelled.
    }
  }
  await clearBusyCache(db);
  return { ok: true, calendarName: cal.name };
}

/* ------------------------------------------------------------------ */
/* Customer email (sent through the connected Gmail account)          */
/* ------------------------------------------------------------------ */

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64Url(value: string): string {
  return base64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function wrapBase64(value: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines.join("\r\n");
}

function encodeHeader(value: string): string {
  // Plain ASCII headers pass through; anything else is RFC 2047 encoded.
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}

export interface SentEmail {
  id: string;
  threadId: string;
  from: string;
}

/**
 * Send a plain-text email from the Google account connected for the delivery
 * calendar. Requires the gmail.send scope, which is requested when the owner
 * connects (or reconnects) Google in Setup.
 */
export async function sendCustomerEmail(
  env: Env,
  db: D1Database,
  opts: { to: string; subject: string; text: string },
): Promise<SentEmail> {
  const cfg = await googleConfig(env, db);
  if (!cfg.refreshToken) {
    throw new GoogleError("Connect Google in Setup before emailing customers.", 400);
  }
  if (!cfg.accountEmail) {
    throw new GoogleError("Reconnect Google so the sender email address is known.", 400);
  }
  const to = opts.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    throw new GoogleError("This order does not have a valid customer email address.", 400);
  }
  const from = cfg.accountEmail;
  const mime = [
    `From: "All Fired Up" <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(base64(new TextEncoder().encode(opts.text))),
  ].join("\r\n");
  const raw = base64Url(mime);

  const attempt = async (token: string) =>
    fetch(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });

  let res = await attempt(await accessToken(env, db));
  if (res.status === 401) {
    res = await attempt(await accessToken(env, db, true));
  }
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };
  if (!res.ok || !data.id) {
    if (res.status === 403) {
      throw new GoogleError(
        "Gmail refused the message. Reconnect Google in Setup, accept the email permission and make sure the Gmail API is enabled for the project.",
        403,
      );
    }
    throw new GoogleError(data.error?.message || `Gmail returned ${res.status}.`, res.status === 401 ? 401 : 502);
  }
  return { id: data.id, threadId: data.threadId ?? "", from };
}
