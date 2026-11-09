import { hashPassword, randomHex, newOrderRef, newToken } from "./crypto";
import { addDays, isWeekday, nextWeekdays, todayLondon, windowById } from "./time";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_URL?: string;
  GOOGLE_CALENDAR_NAME?: string;
}

export const BUSINESS = {
  name: "All Fired Up",
  tagline: "Quality kiln-dried logs, delivered locally",
  phone: "0000 000 000",
  email: "orders@allfiredup.co.uk",
  address: "Foresters Lodge, Bradenham Lane, Scarning, Dereham, Norfolk NR19 2LA",
  radiusMiles: 20,
  deliveryPrefixes: ["NR", "IP", "PE", "CB"],
  defaultCalendarName: "All Fired Up Deliveries",
  // Created ahead of launch in the connected Google account. The OAuth flow
  // verifies access and can create a fresh calendar if this one is not visible.
  defaultCalendarId:
    "c4e39641e965a86772b76a42123e854c9170241160237b9cb531a5867a6fb1cb@group.calendar.google.com",
};

export const DELIVERY_FEE_PENCE = 1200;
export const FREE_DELIVERY_THRESHOLD_PENCE = 25000;

export const ORDER_STATUSES = [
  "new",
  "confirmed",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "refunded",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface ProductRow {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  price_pence: number;
  unit: string;
  category: string;
  image: string;
  max_qty: number;
  addon_only: number;
  requires_firewood: number;
  sort: number;
  active: number;
  note: string;
}

export interface OrderRow {
  id: string;
  ref: string;
  public_token: string;
  status: string;
  payment_status: string;
  customer_name: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  postcode: string;
  notes: string;
  delivery_date: string;
  window_id: number;
  window_label: string;
  subtotal_pence: number;
  delivery_pence: number;
  total_pence: number;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  calendar_event_id: string | null;
  calendar_event_link: string | null;
  calendar_error: string | null;
  reservation_expires_at: number | null;
  paid_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  is_sample: number;
}

export interface OrderEmailRow {
  id: string;
  order_id: string;
  to_email: string;
  subject: string;
  body: string;
  gmail_id: string;
  sent_at: string;
}

export interface BlockRow {
  id: string;
  date: string;
  window_id: number | null;
  capacity: number;
  note: string;
  calendar_event_id: string | null;
  created_at: string;
}

export const DEFAULT_PRODUCTS = [
  {
    id: "large-dumpy-bag",
    name: "Large dumpy bag of kiln-dried logs",
    subtitle: "Approx. 230 logs · mixed hardwood",
    description:
      "A generous bag of locally sourced ash, oak, beech and birch, cut to roughly 9 inches and dried below 20% moisture.",
    price_pence: 14500,
    unit: "per bag",
    category: "Logs",
    image: "/img/logs-dumpy.svg",
    max_qty: 6,
    addon_only: 0,
    requires_firewood: 0,
    sort: 1,
    active: 1,
    note: "Dumpy bags are delivered within 15 miles of our yard.",
  },
  {
    id: "loose-load-2m3",
    name: "Kiln-dried hardwood loose load",
    subtitle: "2m³ · approx. 600 logs",
    description:
      "Our most popular loose load. Ready to burn, clean-handling hardwood that lights easily and throws good heat.",
    price_pence: 33000,
    unit: "per 2m³ load",
    category: "Loose loads",
    image: "/img/logs-loose.svg",
    max_qty: 4,
    addon_only: 0,
    requires_firewood: 0,
    sort: 2,
    active: 1,
    note: "Standard delivery is free on loose loads.",
  },
  {
    id: "loose-load-3m3",
    name: "Kiln-dried hardwood loose load",
    subtitle: "3m³ · approx. 900 logs",
    description:
      "Extra capacity for busy stoves and open fires, or for sharing with a neighbour. Same kiln-dried, local hardwood.",
    price_pence: 47500,
    unit: "per 3m³ load",
    category: "Loose loads",
    image: "/img/logs-loose.svg",
    max_qty: 3,
    addon_only: 0,
    requires_firewood: 0,
    sort: 3,
    active: 1,
    note: "Standard delivery is free on loose loads.",
  },
  {
    id: "logs-20-nets",
    name: "20 nets of kiln-dried logs",
    subtitle: "Handy nets · ready to stack",
    description:
      "Twenty tidy nets of dry hardwood, ideal for a log store, a garage or splitting an order between households.",
    price_pence: 18000,
    unit: "per 20 nets",
    category: "Nets",
    image: "/img/logs-nets.svg",
    max_qty: 5,
    addon_only: 0,
    requires_firewood: 0,
    sort: 4,
    active: 1,
    note: "",
  },
  {
    id: "kindling",
    name: "Kiln-dried kindling",
    subtitle: "One generous bundle",
    description:
      "Dry, easy-to-light kindling to get your fire going cleanly. Delivered with your logs so it stays dry in transit.",
    price_pence: 500,
    unit: "per bundle",
    category: "Fire starters",
    image: "/img/kindling.svg",
    max_qty: 10,
    addon_only: 1,
    requires_firewood: 1,
    sort: 5,
    active: 1,
    note: "Kindling is only delivered with a firewood order.",
  },
  {
    id: "firelighters",
    name: "Natural firelighters",
    subtitle: "Box of 32",
    description:
      "Odourless, natural firelighters made for wood burners and open fires. A simple, reliable light every time.",
    price_pence: 800,
    unit: "per box",
    category: "Fire starters",
    image: "/img/firelighters.svg",
    max_qty: 6,
    addon_only: 0,
    requires_firewood: 0,
    sort: 6,
    active: 1,
    note: "",
  },
  {
    id: "smokeless-coal-25kg",
    name: "25kg smokeless coal",
    subtitle: "For multi-fuel stoves",
    description:
      "A 25kg bag of smokeless coal for multi-fuel stoves. Delivered alongside your logs to keep the fire going overnight.",
    price_pence: 2200,
    unit: "per 25kg bag",
    category: "Fuel",
    image: "/img/coal.svg",
    max_qty: 6,
    addon_only: 1,
    requires_firewood: 1,
    sort: 7,
    active: 1,
    note: "Coal is only delivered with a firewood order.",
  },
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_pence INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  max_qty INTEGER NOT NULL DEFAULT 6,
  addon_only INTEGER NOT NULL DEFAULT 0,
  requires_firewood INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 99,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  public_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  customer_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address1 TEXT NOT NULL DEFAULT '',
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  postcode TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  delivery_date TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  window_label TEXT NOT NULL DEFAULT '',
  subtotal_pence INTEGER NOT NULL DEFAULT 0,
  delivery_pence INTEGER NOT NULL DEFAULT 0,
  total_pence INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  calendar_event_id TEXT,
  calendar_event_link TEXT,
  calendar_error TEXT,
  reservation_expires_at INTEGER,
  paid_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(delivery_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_pence INTEGER NOT NULL,
  line_pence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_emails (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  gmail_id TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_order ON order_emails(order_id);
CREATE TABLE IF NOT EXISTS delivery_reminders (
  order_id TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sending',
  gmail_id TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  attempted_at TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (order_id, delivery_date)
);
CREATE INDEX IF NOT EXISTS idx_reminders_date ON delivery_reminders(delivery_date, state);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  window_id INTEGER,
  capacity INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  calendar_event_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);
CREATE TABLE IF NOT EXISTS slot_locks (
  date TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (date, window_id, seq)
);
CREATE TABLE IF NOT EXISTS day_locks (
  date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (date, seq)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

let initPromise: Promise<void> | null = null;

export async function ensureDb(db: D1Database): Promise<void> {
  if (!initPromise) {
    initPromise = initialise(db).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function initialise(db: D1Database): Promise<void> {
  // Warm isolates can skip all DDL and seeding once the schema is ready.
  try {
    const ready = await db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .first<{ value: string }>();
    if (ready?.value === "3") return;
  } catch {
    // A fresh D1 database has no settings table yet.
  }

  // D1's multi-statement exec is picky about newlines inside CREATE TABLE, so
  // run each DDL statement separately in one atomic batch.
  const schemaStatements = SCHEMA.split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));

  const productCount = await db.prepare("SELECT COUNT(*) AS n FROM products").first<{ n: number }>();
  if (!productCount || productCount.n === 0) {
    const statements = DEFAULT_PRODUCTS.map((p) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO products
           (id, name, subtitle, description, price_pence, unit, category, image, max_qty, addon_only, requires_firewood, sort, active, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          p.id,
          p.name,
          p.subtitle,
          p.description,
          p.price_pence,
          p.unit,
          p.category,
          p.image,
          p.max_qty,
          p.addon_only,
          p.requires_firewood,
          p.sort,
          p.active,
          p.note,
        ),
    );
    await db.batch(statements);
  }

  const sessionSecret = await getSetting(db, "session_secret");
  if (!sessionSecret) await setSetting(db, "session_secret", randomHex(32));

  const passwordHash = await getSetting(db, "admin_password_hash");
  if (!passwordHash) {
    await setSetting(db, "admin_password_hash", await hashPassword("firewood2026"));
    await setSetting(db, "admin_password_default", "1");
  }
  if ((await getSetting(db, "admin_password_default")) === null) {
    await setSetting(db, "admin_password_default", "1");
  }

  const calendarName = await getSetting(db, "google_calendar_name");
  if (!calendarName) await setSetting(db, "google_calendar_name", BUSINESS.defaultCalendarName);

  const calendarId = await getSetting(db, "google_calendar_id");
  if (!calendarId) await setSetting(db, "google_calendar_id", BUSINESS.defaultCalendarId);

  const seeded = await getSetting(db, "sample_orders_seeded");
  if (seeded !== "1") {
    await seedSampleOrders(db);
    await setSetting(db, "sample_orders_seeded", "1");
  }

  // Written last so a partially completed first boot is retried.
  await setSetting(db, "schema_version", "3");
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function getSettings(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const placeholders = keys.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results ?? []) out[r.key] = r.value;
  return out;
}

export function deliveryFeeFor(subtotal: number): number {
  return subtotal >= FREE_DELIVERY_THRESHOLD_PENCE ? 0 : DELIVERY_FEE_PENCE;
}

export function isDeliveryPostcode(postcode: string): boolean {
  const clean = postcode.trim().toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^([A-Z]{1,2})\d/);
  if (!match) return false;
  return BUSINESS.deliveryPrefixes.includes(match[1]);
}

export function normalisePostcode(postcode: string): string {
  const clean = postcode.trim().toUpperCase().replace(/\s+/g, "");
  if (clean.length < 5) return clean;
  return `${clean.slice(0, clean.length - 3)} ${clean.slice(-3)}`;
}

async function seedSampleOrders(db: D1Database): Promise<void> {
  const products = new Map<string, (typeof DEFAULT_PRODUCTS)[number]>(
    DEFAULT_PRODUCTS.map((p) => [p.id, p]),
  );
  const dates = nextWeekdays(todayLondon(), 6, 3);
  const now = new Date();
  const iso = now.toISOString();

  interface SampleItem {
    id: string;
    qty: number;
  }
  interface Sample {
    ref: string;
    name: string;
    email: string;
    phone: string;
    address1: string;
    address2: string;
    city: string;
    postcode: string;
    notes: string;
    date: string;
    windowId: number;
    status: string;
    items: SampleItem[];
    day?: number;
    slotSeq?: number;
    createdDaysAgo: number;
  }

  const samples: Sample[] = [
    {
      ref: "AFU-7K2M9P",
      name: "Emma Whitfield",
      email: "emma.whitfield@example.com",
      phone: "07700 900123",
      address1: "12 Fakenham Road",
      address2: "",
      city: "Dereham",
      postcode: "NR20 4AB",
      notes: "Leave by the side gate, please. No need to knock.",
      date: dates[0],
      windowId: 1,
      status: "confirmed",
      items: [
        { id: "large-dumpy-bag", qty: 1 },
        { id: "kindling", qty: 1 },
      ],
      day: 1,
      slotSeq: 1,
      createdDaysAgo: 2,
    },
    {
      ref: "AFU-4T8Q2X",
      name: "James Holloway",
      email: "james.holloway@example.com",
      phone: "07700 900456",
      address1: "48 Unthank Road",
      address2: "",
      city: "Norwich",
      postcode: "NR2 2RN",
      notes: "Drive is narrow — please reverse in.",
      date: dates[0],
      windowId: 3,
      status: "new",
      items: [
        { id: "loose-load-2m3", qty: 1 },
        { id: "firelighters", qty: 1 },
      ],
      day: 2,
      slotSeq: 1,
      createdDaysAgo: 1,
    },
    {
      ref: "AFU-9C5L7R",
      name: "Priya Nair",
      email: "priya.nair@example.com",
      phone: "07700 900789",
      address1: "7 Woodbridge Road",
      address2: "Flat 3",
      city: "Ipswich",
      postcode: "IP4 1EB",
      notes: "Bags around the back of the flats, if possible.",
      date: dates[1],
      windowId: 2,
      status: "confirmed",
      items: [{ id: "logs-20-nets", qty: 1 }],
      day: 1,
      slotSeq: 1,
      createdDaysAgo: 3,
    },
    {
      ref: "AFU-6B3N8W",
      name: "Tom and Ruth Ellis",
      email: "ruth.ellis@example.com",
      phone: "07700 900234",
      address1: "Ormond House",
      address2: "High Street",
      city: "Cambridge",
      postcode: "CB2 1AA",
      notes: "Call on arrival and we will open the double gates.",
      date: dates[2],
      windowId: 4,
      status: "confirmed",
      items: [{ id: "loose-load-3m3", qty: 1 }],
      day: 1,
      slotSeq: 1,
      createdDaysAgo: 4,
    },
    {
      ref: "AFU-2H9J5D",
      name: "Margaret Cole",
      email: "margaret.cole@example.com",
      phone: "07700 900567",
      address1: "3 Gayton Road",
      address2: "",
      city: "King's Lynn",
      postcode: "PE30 1AA",
      notes: "Please leave on the driveway, in front of the garage.",
      date: dates[3],
      windowId: 1,
      status: "confirmed",
      items: [{ id: "large-dumpy-bag", qty: 1 }],
      day: 1,
      slotSeq: 1,
      createdDaysAgo: 5,
    },
    {
      ref: "AFU-8M4V6K",
      name: "Daniel Okafor",
      email: "daniel.okafor@example.com",
      phone: "07700 900890",
      address1: "22 Norwich Road",
      address2: "",
      city: "Attleborough",
      postcode: "NR17 2AA",
      notes: "",
      date: addDays(todayLondon(), -6),
      windowId: 3,
      status: "delivered",
      items: [{ id: "loose-load-2m3", qty: 1 }],
      createdDaysAgo: 9,
    },
  ];

  const statements: D1PreparedStatement[] = [];
  for (const sample of samples) {
    if (!isWeekday(sample.date)) continue;
    const window = windowById(sample.windowId);
    if (!window) continue;
    const orderId = crypto.randomUUID();
    const subtotal = sample.items.reduce((sum, item) => {
      const product = products.get(item.id);
      return sum + (product ? product.price_pence * item.qty : 0);
    }, 0);
    const delivery = deliveryFeeFor(subtotal);
    const createdAt = new Date(now.getTime() - sample.createdDaysAgo * 86400000).toISOString();
    const paidAt = createdAt;

    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO orders
           (id, ref, public_token, status, payment_status, customer_name, email, phone, address1, address2, city, postcode, notes,
            delivery_date, window_id, window_label, subtotal_pence, delivery_pence, total_pence, paid_at, created_at, updated_at, is_sample)
           VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          orderId,
          sample.ref,
          newToken(),
          sample.status,
          sample.name,
          sample.email,
          sample.phone,
          sample.address1,
          sample.address2,
          sample.city,
          sample.postcode,
          sample.notes,
          sample.date,
          sample.windowId,
          window.label,
          subtotal,
          delivery,
          subtotal + delivery,
          paidAt,
          createdAt,
          createdAt,
        ),
    );

    for (const item of sample.items) {
      const product = products.get(item.id);
      if (!product) continue;
      statements.push(
        db
          .prepare(
            "INSERT INTO order_items (order_id, product_id, name, qty, unit_pence, line_pence) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(orderId, item.id, product.name, item.qty, product.price_pence, product.price_pence * item.qty),
      );
    }

    if (sample.day && sample.slotSeq) {
      statements.push(
        db
          .prepare("INSERT OR IGNORE INTO day_locks (date, seq, order_id, expires_at) VALUES (?, ?, ?, NULL)")
          .bind(sample.date, sample.day, orderId),
        db
          .prepare(
            "INSERT OR IGNORE INTO slot_locks (date, window_id, seq, order_id, expires_at) VALUES (?, ?, ?, ?, NULL)",
          )
          .bind(sample.date, sample.windowId, sample.slotSeq, orderId),
      );
    }
  }

  if (statements.length) await db.batch(statements);
  void iso;
}

export async function cleanupExpiredReservations(db: D1Database): Promise<void> {
  const now = Date.now();
  const expired = await db
    .prepare("SELECT 1 AS x FROM slot_locks WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 1")
    .bind(now)
    .first();
  if (!expired) return;
  await db.batch([
    db.prepare("DELETE FROM slot_locks WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    db.prepare("DELETE FROM day_locks WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
    db
      .prepare(
        `UPDATE orders SET status = 'expired', updated_at = ?
         WHERE payment_status = 'unpaid' AND status IN ('new','pending_payment')
           AND reservation_expires_at IS NOT NULL AND reservation_expires_at <= ?`,
      )
      .bind(new Date(now).toISOString(), now),
  ]);
}

export async function orderItems(db: D1Database, orderId: string) {
  const rows = await db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .bind(orderId)
    .all<{ id: number; order_id: string; product_id: string; name: string; qty: number; unit_pence: number; line_pence: number }>();
  return rows.results ?? [];
}

export async function orderEmails(db: D1Database, orderId: string): Promise<OrderEmailRow[]> {
  const rows = await db
    .prepare("SELECT * FROM order_emails WHERE order_id = ? ORDER BY sent_at DESC")
    .bind(orderId)
    .all<OrderEmailRow>();
  return rows.results ?? [];
}

export function orderSummaryShort(items: { name: string; qty: number }[]): string {
  const parts = items.map((i) => `${i.qty} × ${i.name.replace(" of kiln-dried logs", "").replace("Kiln-dried hardwood loose load", "loose load")}`);
  let summary = parts.join(", ");
  if (summary.length > 90) summary = summary.slice(0, 87).trimEnd() + "…";
  return summary || "Firewood order";
}
