import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { constantTimeEqual, hmacHex } from "./crypto";
import { getSetting, type Env } from "./db";

export const ADMIN_COOKIE = "afu_admin";
const SESSION_DAYS = 7;

export async function sessionSecret(env: Env, db: D1Database): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const stored = await getSetting(db, "session_secret");
  if (!stored) throw new Error("Session secret is not configured");
  return stored;
}

export async function issueAdminSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const secret = await sessionSecret(c.env, c.env.DB);
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const payload = `admin.${expires}`;
  const sig = await hmacHex(secret, payload);
  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, ADMIN_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps,
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function clearAdminSession(c: Context<{ Bindings: Env }>): Promise<void> {
  deleteCookie(c, ADMIN_COOKIE, { path: "/" });
}

export async function isAdmin(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const raw = getCookie(c, ADMIN_COOKIE);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [prefix, expiresRaw, sig] = parts;
  if (prefix !== "admin") return false;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const secret = await sessionSecret(c.env, c.env.DB);
  const expected = await hmacHex(secret, `${prefix}.${expiresRaw}`);
  return constantTimeEqual(sig, expected);
}
