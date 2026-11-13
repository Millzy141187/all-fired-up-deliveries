import type { D1Database } from "@cloudflare/workers-types";
import {
  DELIVERY_BANDS,
  MIN_NOTICE_HOURS,
  TRUCK_UNITS_PER_DAY,
  addDays,
  bandById,
  bandEndUtc,
  bandStartUtc,
  formatLongDate,
  formatShortDate,
  isWeekday,
  londonToUtc,
  todayLondon,
  weekdayIndex,
  type DeliveryBandId,
} from "./time";
import { cleanupExpiredReservations, type BlockRow, type Env, type OrderRow } from "./db";
import { calendarBusy, type BusyInterval } from "./google";
import { zoneForDate } from "./zones";

export type SlotState = "available" | "full" | "blocked" | "past" | "busy";

export interface BandView {
  id: DeliveryBandId;
  label: string;
  short: string;
  state: SlotState;
  reason?: string;
}

export interface DayView {
  date: string;
  label: string;
  longLabel: string;
  weekday: string;
  zoneId: string;
  zoneName: string;
  closed: boolean;
  closedLabel: string;
  note?: string;
  unitsUsed: number;
  unitsTotal: number;
  unitsLeft: number;
  bands: BandView[];
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
    unitsPerDay: number;
    minNoticeHours: number;
    reservationMinutes: number;
  };
}

interface AvailabilityContext {
  blocks: BlockRow[];
  usedUnits: Map<string, number>;
  busy: BusyInterval[];
  cutoff: number;
  now: number;
  includeNotes: boolean;
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

  const [blockRes, unitRes, busyResult] = await Promise.all([
    db.prepare("SELECT * FROM blocks WHERE date >= ? AND date <= ?").bind(fromDate, toDate).all<BlockRow>(),
    db
      .prepare(
        `SELECT delivery_date, COALESCE(SUM(space_units), 0) AS units FROM orders
         WHERE delivery_date >= ? AND delivery_date <= ?
           AND status NOT IN ('cancelled','refunded','expired')
           AND (payment_status = 'paid' OR (reservation_expires_at IS NOT NULL AND reservation_expires_at > ?))
         GROUP BY delivery_date`,
      )
      .bind(fromDate, toDate, now)
      .all<{ delivery_date: string; units: number }>(),
    calendarBusy(env, db, londonToUtc(fromDate, "00:00").toISOString(), londonToUtc(addDays(toDate, 1), "00:00").toISOString()),
  ]);

  const usedUnits = new Map<string, number>();
  for (const row of unitRes.results ?? []) usedUnits.set(row.delivery_date, Number(row.units) || 0);

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
      usedUnits,
      busy: busyResult.intervals,
      cutoff,
      now,
      includeNotes,
    },
    calendar,
  };
}

function bandBlockFor(date: string, band: DeliveryBandId, blocks: BlockRow[]): BlockRow | undefined {
  return blocks.find((block) => {
    if (block.date !== date) return false;
    if (block.band) return block.band === band;
    // Legacy blocks were created against the old two-hour windows.
    if (band === "morning") return block.window_id === 1 || block.window_id === 2;
    return block.window_id === 3 || block.window_id === 4;
  });
}

export function buildDay(date: string, ctx: AvailabilityContext): DayView {
  const zone = zoneForDate(date);
  const dayBlocks = ctx.blocks.filter((block) => block.date === date);
  const wholeDayBlock = dayBlocks.find((block) => block.window_id === null && !block.band);
  const note = ctx.includeNotes ? wholeDayBlock?.note || undefined : undefined;
  const unitsUsed = Math.round((ctx.usedUnits.get(date) ?? 0) * 100) / 100;
  const unitsLeft = Math.max(0, Math.round((TRUCK_UNITS_PER_DAY - unitsUsed) * 100) / 100);

  const bands: BandView[] = DELIVERY_BANDS.map((band) => {
    const block = bandBlockFor(date, band.id, dayBlocks);
    const start = bandStartUtc(date, band.id).getTime();
    const end = bandEndUtc(date, band.id).getTime();
    let state: SlotState = "available";
    let reason: string | undefined;

    if (wholeDayBlock) {
      state = "blocked";
      reason = "No deliveries this day";
    } else if (block && block.capacity === 0) {
      state = "blocked";
      reason = "Closed for this round";
    } else if (start < ctx.cutoff) {
      state = "past";
      reason = "Needs 24 hours' notice";
    } else if (unitsLeft <= 0) {
      state = "full";
      reason = "Truck full";
    } else if (ctx.busy.some((busy) => busy.start < end && busy.end > start)) {
      state = "busy";
      reason = "Busy in Google Calendar";
    }

    return { id: band.id, label: band.label, short: band.short, state, reason };
  });

  const closed = Boolean(wholeDayBlock);
  return {
    date,
    label: formatShortDate(date),
    longLabel: formatLongDate(date),
    weekday: new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    ),
    zoneId: zone?.id || "",
    zoneName: zone?.name || "No round",
    closed,
    closedLabel: closed ? "No deliveries available" : "",
    note,
    unitsUsed,
    unitsTotal: TRUCK_UNITS_PER_DAY,
    unitsLeft,
    bands,
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
      // Hide dates where the last delivery band already fails the 24-hour notice rule.
      const lastBandEnd = londonToUtc(date, "17:00").getTime();
      if (lastBandEnd < ctx.cutoff) continue;
    }
    out.push(day);
  }

  return {
    days: out,
    calendar,
    rules: {
      unitsPerDay: TRUCK_UNITS_PER_DAY,
      minNoticeHours: MIN_NOTICE_HOURS,
      reservationMinutes: 15,
    },
  };
}

export async function getSlotState(
  env: Env,
  db: D1Database,
  date: string,
  band: DeliveryBandId,
): Promise<{ day: DayView; slot: BandView | null }> {
  const { ctx } = await loadAvailabilityContext(env, db, date, date);
  const day = buildDay(date, ctx);
  return { day, slot: day.bands.find((item) => item.id === band) ?? null };
}

const UNIT_SLOTS = Math.round(TRUCK_UNITS_PER_DAY * 10);

/**
 * Claim truck space in tenths of a unit. Rows are inserted with INSERT OR IGNORE
 * so two simultaneous checkouts cannot both take the last space.
 */
export async function acquireCapacity(
  db: D1Database,
  date: string,
  units: number,
  orderId: string,
  expiresAt: number | null,
): Promise<boolean> {
  const need = Math.min(UNIT_SLOTS, Math.ceil(units * 10 - 1e-9));
  if (need <= 0) return true;
  const taken = await db
    .prepare(
      "SELECT unit FROM capacity_locks WHERE date = ? AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(date, Date.now())
    .all<{ unit: number }>();
  const takenUnits = new Set((taken.results ?? []).map((row) => row.unit));
  const free: number[] = [];
  for (let unit = 1; unit <= UNIT_SLOTS && free.length < need; unit++) {
    if (!takenUnits.has(unit)) free.push(unit);
  }
  if (free.length < need) return false;
  const results = await db.batch(
    free.map((unit) =>
      db
        .prepare("INSERT OR IGNORE INTO capacity_locks (date, unit, order_id, expires_at) VALUES (?, ?, ?, ?)")
        .bind(date, unit, orderId, expiresAt),
    ),
  );
  let claimed = 0;
  for (const result of results) claimed += result.meta.changes ?? 0;
  if (claimed < need) {
    await releaseOrderLocks(db, orderId);
    return false;
  }
  return true;
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
  const taken = new Set((used.results ?? []).map((row) => row.seq));
  for (let seq = 1; seq <= 6; seq++) {
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
  const taken = new Set((used.results ?? []).map((row) => row.seq));
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
    db.prepare("DELETE FROM capacity_locks WHERE order_id = ?").bind(orderId),
    db.prepare("DELETE FROM slot_locks WHERE order_id = ?").bind(orderId),
    db.prepare("DELETE FROM day_locks WHERE order_id = ?").bind(orderId),
  ]);
}

export async function makeOrderLocksPermanent(db: D1Database, orderId: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE capacity_locks SET expires_at = NULL WHERE order_id = ?").bind(orderId),
    db.prepare("UPDATE slot_locks SET expires_at = NULL WHERE order_id = ?").bind(orderId),
    db.prepare("UPDATE day_locks SET expires_at = NULL WHERE order_id = ?").bind(orderId),
  ]);
}

export async function orderHasCapacity(db: D1Database, orderId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM capacity_locks WHERE order_id = ? LIMIT 1")
    .bind(orderId)
    .first();
  return Boolean(row);
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
    const dayOrders = orders.filter(
      (order) => order.delivery_date === date && !["cancelled", "refunded", "expired"].includes(order.status),
    );
    cells.push({
      date,
      inMonth: true,
      orders: dayOrders.length,
      paid: dayOrders.filter((order) => order.payment_status === "paid").length,
      blocked: blocks.some((block) => block.date === date && block.window_id === null && !block.band),
      weekend: !isWeekday(date),
      capacityUsed: Math.round(dayOrders.reduce((sum, order) => sum + (order.space_units || 0), 0) * 100) / 100,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ date: "", inMonth: false, orders: 0, paid: 0, blocked: false, weekend: false, capacityUsed: 0 });
  }
  return { month, cells };
}

export { bandById };
