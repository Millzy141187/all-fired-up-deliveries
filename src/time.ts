// Europe/London date and delivery-window helpers. Delivery slots are defined in
// local wall-clock time; conversions go through the IANA timezone so BST/GMT
// changes are handled by the runtime.

export const TIME_ZONE = "Europe/London";

export const DELIVERY_WINDOWS = [
  { id: 1, start: "09:00", end: "11:00", label: "09:00 – 11:00" },
  { id: 2, start: "11:00", end: "13:00", label: "11:00 – 13:00" },
  { id: 3, start: "13:00", end: "15:00", label: "13:00 – 15:00" },
  { id: 4, start: "15:00", end: "17:00", label: "15:00 – 17:00" },
] as const;

export const MAX_PER_WINDOW = 2;
export const MAX_PER_DAY = 6;
export const MIN_NOTICE_HOURS = 24;
export const RESERVATION_MINUTES = 15;

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function zonedParts(date: Date) {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(date: Date): number {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a London wall-clock date + time into a UTC Date. */
export function londonToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = base;
  for (let i = 0; i < 3; i++) ts = base - offsetMs(new Date(ts));
  return new Date(ts);
}

export function todayLondon(): string {
  const p = zonedParts(new Date());
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function nowLondonTime(): string {
  const p = zonedParts(new Date());
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekday(date: string): boolean {
  const day = weekdayIndex(date);
  return day >= 1 && day <= 5;
}

export function formatLongDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatShortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function windowById(id: number) {
  return DELIVERY_WINDOWS.find((w) => w.id === id) ?? null;
}

export function windowStartUtc(date: string, windowId: number): Date {
  const w = windowById(windowId);
  if (!w) throw new Error("Unknown delivery window");
  return londonToUtc(date, w.start);
}

export function windowEndUtc(date: string, windowId: number): Date {
  const w = windowById(windowId);
  if (!w) throw new Error("Unknown delivery window");
  return londonToUtc(date, w.end);
}

/** Delivery date must start at least 24 hours from now. */
export function meetsNotice(date: string, windowId: number, now = new Date()): boolean {
  return windowStartUtc(date, windowId).getTime() >= now.getTime() + MIN_NOTICE_HOURS * 3600_000;
}

export function minutesBetween(a: number, b: number): number {
  return Math.max(0, Math.round((b - a) / 60000));
}

export function nextWeekdays(from: string, count: number, minDaysAhead = 3): string[] {
  const out: string[] = [];
  let cursor = addDays(from, minDaysAhead);
  for (let i = 0; i < 90 && out.length < count; i++) {
    if (isWeekday(cursor)) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}
