import type { D1Database } from "@cloudflare/workers-types";
import {
  MAX_PER_DAY,
  MAX_PER_WINDOW,
  MIN_NOTICE_HOURS,
  DELIVERY_WINDOWS,
  addDays,
  formatLongDate,
  formatShortDate,
  isWeekday,
  londonToUtc,
  todayLondon,
  weekdayIndex,
} from "./time";
import { cleanupExpiredReservations, type BlockRow, type Env, type OrderRow } from "./db";
import { calendarBusy, type BusyInterval } from "./google";

export type SlotState = "available" | "full" | "blocked" | "past" | "busy";

export interface SlotView {
  id: number;
  label: string;
  start: string;
  end: string;
  state: SlotState;
  capacity: number;
  booked: number;
  remaining: number;
  reason?: string;
  blockNote?: string;
}

export interface DayView {
  date: string;
  label: string;
  longLabel: string;
  weekday: string;
  closed: boolean;
  closedLabel: string;
  note?: string;
  booked: number;
  capacity: number;
  windows: SlotView[];
}

export interface AvailabilityResult {
  days: DayView[];
  calendar: {
    status: "connected" | "not_connected" | "error";
    name: string;
    message?: string;
    error?: string;
  };
  rules: {
    maxPerWindow: number;
    maxPerDay: number;
    minNoticeHours: number;
    reservationMinutes: number;
  };
}

interface AvailabilityContext {
  blocks: BlockRow[];
  slotLocks: Map<string, number>;
  dayLocks: Map<string, number>;
  busy: BusyInterval[];
  cutoff: number;
  now: number;
  includeNotes: boolean;
}

function slotKey(date: string, windowId: number) {
  return `${date}:${windowId}`;
}

export async function loadAvailabilityContext(
  env: Env,
  db: D1Database,
  fromDate: string,
  toDate: string,
  includeNotes = false,
): Promise<{ ctx: AvailabilityContext; calendar: AvailabilityResult["calendar"] }> {
  await cleanupExpiredReservations(db);
  const now = Date.now();
  const cutoff = now + MIN_NOTICE_HOURS * 3600_000;

  const [blockRes, slotRes, dayRes, busyResult] = await Promise.all([
    db.prepare("SELECT * FROM blocks WHERE date >= ? AND date <= ?").bind(fromDate, toDate).all<BlockRow>(),
    db
      .prepare(
        `SELECT date, window_id, COUNT(*) AS n FROM slot_locks
         WHERE date >= ? AND date <= ? AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY date, window_id`,
      )
      .bind(fromDate, toDate, now)
      .all<{ date: string; window_id: number; n: number }>(),
    db
      .prepare(
        `SELECT date, COUNT(*) AS n FROM day_locks
         WHERE date >= ? AND date <= ? AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY date`,
      )
      .bind(fromDate, toDate, now)
      .all<{ date: string; n: number }>(),
    calendarBusy(env, db, londonToUtc(fromDate, "00:00").toISOString(), londonToUtc(addDays(toDate, 1), "00:00").toISOString()),
  ]);

  const slotLocks = new Map<string, number>();
  for (const r of slotRes.results ?? []) slotLocks.set(slotKey(r.date, r.window_id), r.n);
  const dayLocks = new Map<string, number>();
  for (const r of dayRes.results ?? []) dayLocks.set(r.date, r.n);

  const calendar: AvailabilityResult["calendar"] = {
    status: busyResult.status,
    name: busyResult.calendarName,
  };
  if (busyResult.status === "error") {
    calendar.error = busyResult.error;
    calendar.message = "Live calendar check unavailable";
  }

  return {
    ctx: {
      blocks: blockRes.results ?? [],
      slotLocks,
      dayLocks,
      busy: busyResult.intervals,
      cutoff,
      now,
      includeNotes,
    },
    calendar,
  };
}

export function buildDay(date: string, ctx: AvailabilityContext): DayView {
  const dayBooked = ctx.dayLocks.get(date) ?? 0;
  const dayBlocks = ctx.blocks.filter((b) => b.date === date);
  const wholeDayBlock = dayBlocks.find((b) => b.window_id === null);
  const note = ctx.includeNotes ? wholeDayBlock?.note || undefined : undefined;

  const windows: SlotView[] = DELIVERY_WINDOWS.map((win) => {
    const block = dayBlocks.find((b) => b.window_id === win.id);
    const capacity = block ? block.capacity : MAX_PER_WINDOW;
    const booked = ctx.slotLocks.get(slotKey(date, win.id)) ?? 0;
    const start = londonToUtc(date, win.start).getTime();
    const end = londonToUtc(date, win.end).getTime();
    let state: SlotState = "available";
    let reason: string | undefined;

    if (wholeDayBlock) {
      state = "blocked";
      reason = "Whole day closed";
    } else if (block && block.capacity === 0) {
      state = "blocked";
      reason = "Window blocked";
    } else if (start < ctx.cutoff) {
      state = "past";
      reason = "Needs 24 hours' notice";
    } else if (dayBooked >= MAX_PER_DAY || booked >= capacity) {
      state = "full";
      reason = "At capacity";
    } else if (ctx.busy.some((b) => b.start < end && b.end > start)) {
      state = "busy";
      reason = "Busy in Google Calendar";
    }

    const remaining =
      state === "available" ? Math.max(0, Math.min(capacity, MAX_PER_DAY - dayBooked) - booked) : 0;

    return {
      id: win.id,
      label: win.label,
      start: win.start,
      end: win.end,
      state,
      capacity: wholeDayBlock ? 0 : capacity,
      booked,
      remaining,
      reason,
      blockNote: ctx.includeNotes ? block?.note || undefined : undefined,
    };
  });

  const closed = Boolean(wholeDayBlock);
  return {
    date,
    label: formatShortDate(date),
    longLabel: formatLongDate(date),
    weekday: new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    ),
    closed,
    closedLabel: closed ? "No deliveries available" : "",
    note,
    booked: dayBooked,
    capacity: closed ? 0 : Math.min(MAX_PER_DAY, windows.reduce((sum, w) => sum + w.capacity, 0)),
    windows,
  };
}

export async function computeAvailability(
  env: Env,
  db: D1Database,
  opts: { from?: string; days?: number; includePast?: boolean; includeNotes?: boolean } = {},
): Promise<AvailabilityResult> {
  const from = opts.from || todayLondon();
  const days = Math.max(1, Math.min(opts.days ?? 42, 120));
  const to = addDays(from, days - 1);
  const { ctx, calendar } = await loadAvailabilityContext(env, db, from, to, Boolean(opts.includeNotes));

  const out: DayView[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (!isWeekday(date)) continue;
    const day = buildDay(date, ctx);
    if (!opts.includePast) {
      // Hide dates where the last delivery window already fails the 24-hour notice rule.
      const lastWindowEnd = londonToUtc(date, "17:00").getTime();
      if (lastWindowEnd < ctx.cutoff) continue;
    }
    out.push(day);
  }

  return {
    days: out,
    calendar,
    rules: {
      maxPerWindow: MAX_PER_WINDOW,
      maxPerDay: MAX_PER_DAY,
      minNoticeHours: MIN_NOTICE_HOURS,
      reservationMinutes: 15,
    },
  };
}

export async function getSlotState(
  env: Env,
  db: D1Database,
  date: string,
  windowId: number,
): Promise<{ day: DayView; slot: SlotView | null }> {
  const { ctx } = await loadAvailabilityContext(env, db, date, date);
  const day = buildDay(date, ctx);
  return { day, slot: day.windows.find((w) => w.id === windowId) ?? null };
}

export async function acquireDayLock(
  db: D1Database,
  date: string,
  orderId: string,
  expiresAt: number | null,
  now: number,
): Promise<boolean> {
  const used = await db
    .prepare("SELECT seq FROM day_locks WHERE date = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(date, now)
    .all<{ seq: number }>();
  const taken = new Set((used.results ?? []).map((r) => r.seq));
  for (let seq = 1; seq <= MAX_PER_DAY; seq++) {
    if (taken.has(seq)) continue;
    const res = await db
      .prepare("INSERT OR IGNORE INTO day_locks (date, seq, order_id, expires_at) VALUES (?, ?, ?, ?)")
      .bind(date, seq, orderId, expiresAt)
      .run();
    if ((res.meta.changes ?? 0) > 0) return true;
  }
  return false;
}

export async function acquireSlotLock(
  db: D1Database,
  date: string,
  windowId: number,
  capacity: number,
  orderId: string,
  expiresAt: number | null,
  now: number,
): Promise<boolean> {
  const used = await db
    .prepare(
      "SELECT seq FROM slot_locks WHERE date = ? AND window_id = ? AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(date, windowId, now)
    .all<{ seq: number }>();
  const taken = new Set((used.results ?? []).map((r) => r.seq));
  for (let seq = 1; seq <= capacity; seq++) {
    if (taken.has(seq)) continue;
    const res = await db
      .prepare(
        "INSERT OR IGNORE INTO slot_locks (date, window_id, seq, order_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(date, windowId, seq, orderId, expiresAt)
      .run();
    if ((res.meta.changes ?? 0) > 0) return true;
  }
  return false;
}

export async function releaseOrderLocks(db: D1Database, orderId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM slot_locks WHERE order_id = ?").bind(orderId),
    db.prepare("DELETE FROM day_locks WHERE order_id = ?").bind(orderId),
  ]);
}

export async function makeOrderLocksPermanent(db: D1Database, orderId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE slot_locks SET expires_at = NULL WHERE order_id = ?").bind(orderId),
    db.prepare("UPDATE day_locks SET expires_at = NULL WHERE order_id = ?").bind(orderId),
  ]);
}

export async function orderHasSlotLock(db: D1Database, orderId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM slot_locks WHERE order_id = ? LIMIT 1")
    .bind(orderId)
    .first();
  return Boolean(row);
}

export function adminCalendarMonth(month: string, orders: OrderRow[], blocks: BlockRow[]) {
  const [year, monthNum] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const firstWeekday = weekdayIndex(`${month}-01`);
  const cells: Array<{
    date: string;
    inMonth: boolean;
    orders: number;
    paid: number;
    blocked: boolean;
    weekend: boolean;
    capacityUsed: number;
  }> = [];

  const startOffset = (firstWeekday + 6) % 7; // Monday-first grid
  for (let i = 0; i < startOffset; i++) {
    cells.push({ date: "", inMonth: false, orders: 0, paid: 0, blocked: false, weekend: false, capacityUsed: 0 });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dayOrders = orders.filter((o) => o.delivery_date === date && !["cancelled", "refunded", "expired"].includes(o.status));
    cells.push({
      date,
      inMonth: true,
      orders: dayOrders.length,
      paid: dayOrders.filter((o) => o.payment_status === "paid").length,
      blocked: blocks.some((b) => b.date === date && b.window_id === null),
      weekend: !isWeekday(date),
      capacityUsed: dayOrders.length,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ date: "", inMonth: false, orders: 0, paid: 0, blocked: false, weekend: false, capacityUsed: 0 });
  }
  return { month, cells };
}
