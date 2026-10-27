// A synthetic but realistic café & mini-market, generated deterministically
// per calendar day: the same date always yields the same orders, so answers
// are stable across requests while "today" keeps moving forward.

import { addDays, daysBetween, parseDate, todayIn, type DateRange } from "../period.ts";
import type {
  CategoryRow,
  CustomerRow,
  DataSource,
  Granularity,
  HourlyRow,
  OrderRow,
  ProductRow,
  SalesSummary,
  StockRow,
  StoreInfo,
  TrendPoint,
  WeekdayRow,
} from "./types.ts";

const TIME_ZONE = "Asia/Riyadh";
const CURRENCY = "SAR";
const MAX_DAYS = 400;

interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  weight: number; // relative popularity
  stock: number;
  reorderLevel: number;
  unit: string;
}

// name, category, price (VAT inclusive), popularity, stock, reorder level, unit
const CATALOG: Array<[string, string, number, number, number, number, string]> = [
  ["Arabic Coffee (Dallah)", "Hot Drinks", 18, 9, 0, 0, "cup"],
  ["Cappuccino", "Hot Drinks", 16, 14, 0, 0, "cup"],
  ["Spanish Latte", "Hot Drinks", 19, 16, 0, 0, "cup"],
  ["Flat White", "Hot Drinks", 17, 7, 0, 0, "cup"],
  ["Karak Tea", "Hot Drinks", 8, 15, 0, 0, "cup"],
  ["Iced Latte", "Cold Drinks", 20, 12, 0, 0, "cup"],
  ["Iced Mocha", "Cold Drinks", 22, 6, 0, 0, "cup"],
  ["Fresh Orange Juice", "Cold Drinks", 15, 8, 0, 0, "cup"],
  ["Mango Smoothie", "Cold Drinks", 21, 6, 0, 0, "cup"],
  ["Mineral Water 500ml", "Cold Drinks", 2, 13, 214, 120, "bottle"],
  ["Laban 1L", "Dairy", 7.5, 6, 38, 40, "pack"],
  ["Fresh Milk 2L", "Dairy", 11, 7, 52, 30, "pack"],
  ["Greek Yogurt", "Dairy", 6, 4, 9, 20, "cup"],
  ["Halloumi Cheese 250g", "Dairy", 17, 3, 24, 12, "pack"],
  ["Butter Croissant", "Bakery", 9, 13, 0, 0, "pc"],
  ["Zaatar Manakish", "Bakery", 10, 10, 0, 0, "pc"],
  ["Cheese Samboosa (3)", "Bakery", 12, 7, 0, 0, "pc"],
  ["Date Maamoul Box", "Bakery", 35, 3, 17, 10, "box"],
  ["Sourdough Loaf", "Bakery", 18, 4, 6, 8, "pc"],
  ["Chicken Shawarma Wrap", "Food", 19, 11, 0, 0, "pc"],
  ["Falafel Sandwich", "Food", 12, 8, 0, 0, "pc"],
  ["Club Sandwich", "Food", 26, 6, 0, 0, "pc"],
  ["Caesar Salad", "Food", 28, 4, 0, 0, "pc"],
  ["Shakshuka", "Food", 24, 5, 0, 0, "pc"],
  ["Basmati Rice 5kg", "Grocery", 49, 3, 31, 15, "bag"],
  ["Sukkari Dates 1kg", "Grocery", 38, 5, 14, 10, "box"],
  ["Olive Oil 1L", "Grocery", 42, 2, 0, 10, "bottle"],
  ["Arabic Coffee Beans 250g", "Grocery", 45, 3, 4, 8, "bag"],
  ["Tahini 450g", "Grocery", 16, 2, 0, 10, "jar"],
  ["Pasta 500g", "Grocery", 6, 3, 88, 30, "pack"],
  ["Potato Chips", "Snacks", 5, 9, 140, 60, "pack"],
  ["Dark Chocolate Bar", "Snacks", 9, 6, 11, 25, "pc"],
  ["Mixed Nuts 200g", "Snacks", 22, 4, 27, 15, "pack"],
  ["Protein Bar", "Snacks", 11, 5, 12, 20, "pc"],
  ["Hand Soap 500ml", "Household", 13, 2, 33, 10, "bottle"],
  ["Tissue Box", "Household", 7, 3, 61, 25, "box"],
  ["Dish Liquid 1L", "Household", 12, 2, 3, 10, "bottle"],
];

const PRODUCTS: Product[] = CATALOG.map(([name, category, price, weight, stock, reorderLevel, unit], i) => ({
  id: i + 1,
  name,
  category,
  price,
  weight,
  stock,
  reorderLevel,
  unit,
}));

const FIRST = ["Ahmed", "Fatima", "Mohammed", "Noura", "Khalid", "Sara", "Omar", "Layla", "Yousef", "Huda", "Faisal", "Reem", "Abdullah", "Maha", "Saad", "Lina", "Tariq", "Dana", "Hassan", "Aisha", "Rahul", "Priya", "John", "Maria"];
const LAST = ["Al-Harbi", "Al-Qahtani", "Al-Otaibi", "Al-Shehri", "Al-Zahrani", "Al-Ghamdi", "Al-Dosari", "Al-Mutairi", "Khan", "Nair", "Fernandes", "Hassan"];

const CUSTOMERS = Array.from({ length: 140 }, (_, i) => ({
  id: i + 1,
  name: `${FIRST[(i * 7) % FIRST.length]} ${LAST[(i * 5 + Math.floor(i / 12)) % LAST.length]}`,
  phone: `+9665${String(10000000 + ((i * 7919) % 89999999)).padStart(8, "0")}`,
  // Pareto-ish loyalty: low ids are regulars.
  weight: 1 / Math.pow(i + 1, 0.85),
}));

const PAYMENTS: Array<[string, number]> = [["mada", 46], ["Cash", 24], ["Visa/Mastercard", 18], ["Apple Pay", 12]];

// Relative order volume per hour of day (store opens 06:00, closes 23:59).
const HOUR_WEIGHTS = [0, 0, 0, 0, 0, 0, 3, 8, 11, 9, 6, 5, 7, 9, 6, 4, 4, 5, 7, 9, 10, 9, 6, 3];
// Mon..Sun, weekend (Fri/Sat) busiest.
const WEEKDAY_FACTOR = [0.92, 0.9, 0.95, 1.05, 1.32, 1.24, 0.98];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface Line {
  product: Product;
  qty: number;
  amount: number;
}

interface Order {
  number: string;
  date: string;
  hour: number;
  customerId: number | null;
  payment: string;
  lines: Line[];
  discount: number;
  total: number; // after discount, VAT inclusive
  refunded: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pick<T>(rand: () => number, items: T[], weightOf: (item: T) => number, total?: number): T {
  const sum = total ?? items.reduce((s, x) => s + weightOf(x), 0);
  let r = rand() * sum;
  for (const item of items) {
    r -= weightOf(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

const PRODUCT_WEIGHT = PRODUCTS.reduce((s, p) => s + p.weight, 0);
const CUSTOMER_WEIGHT = CUSTOMERS.reduce((s, c) => s + c.weight, 0);
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((s, w) => s + w, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

const dayCache = new Map<string, Order[]>();

function ordersForDay(date: string): Order[] {
  const cached = dayCache.get(date);
  if (cached) return cached;
  const rand = mulberry32(seedFor(`cloudpos-demo:${date}`));
  const d = parseDate(date);
  const dow = (d.getUTCDay() + 6) % 7;
  // Slow upward trend (~18%/yr), a Ramadan-ish dip in March, and day noise.
  const t = (d.getTime() - Date.UTC(2025, 0, 1)) / (365 * 86_400_000);
  const seasonal = d.getUTCMonth() === 2 ? 0.82 : d.getUTCMonth() === 11 ? 1.12 : 1;
  const expected = 62 * (1 + 0.18 * t) * WEEKDAY_FACTOR[dow] * seasonal * (0.85 + rand() * 0.3);
  const count = Math.max(10, Math.round(expected));
  const seq = seedFor(date) % 9000;
  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    const hour = pick(rand, HOUR_WEIGHTS.map((w, h) => ({ w, h })), (x) => x.w, HOUR_TOTAL).h;
    const lineCount = 1 + Math.floor(Math.pow(rand(), 1.8) * 4);
    const lines: Line[] = [];
    for (let l = 0; l < lineCount; l++) {
      const product = pick(rand, PRODUCTS, (p) => p.weight, PRODUCT_WEIGHT);
      const existing = lines.find((x) => x.product === product);
      const qty = rand() < 0.82 ? 1 : 2 + Math.floor(rand() * 2);
      if (existing) {
        existing.qty += qty;
        existing.amount = round2(existing.qty * product.price);
      } else {
        lines.push({ product, qty, amount: round2(qty * product.price) });
      }
    }
    const gross = lines.reduce((s, x) => s + x.amount, 0);
    const discount = rand() < 0.08 ? round2(gross * (rand() < 0.5 ? 0.1 : 0.05)) : 0;
    const customerId = rand() < 0.42 ? pick(rand, CUSTOMERS, (c) => c.weight, CUSTOMER_WEIGHT).id : null;
    orders.push({
      number: `INV-${date.replace(/-/g, "").slice(2)}-${String(seq + i).padStart(4, "0")}`,
      date,
      hour,
      customerId,
      payment: pick(rand, PAYMENTS, (p) => p[1]).at(0) as string,
      lines,
      discount,
      total: round2(gross - discount),
      refunded: rand() < 0.012,
    });
  }
  orders.sort((a, b) => a.hour - b.hour);
  if (dayCache.size > MAX_DAYS + 20) dayCache.clear();
  dayCache.set(date, orders);
  return orders;
}

export class DemoSource implements DataSource {
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async info(): Promise<StoreInfo> {
    return {
      mode: "demo",
      company: "Al Noor Café & Market (demo)",
      store: "Riyadh – Olaya branch",
      currency: CURRENCY,
      timeZone: TIME_ZONE,
      user: "Demo manager",
      role: "admin",
    };
  }

  async today(): Promise<string> {
    return todayIn(TIME_ZONE, this.now());
  }

  private currentHour(): number {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(this.now());
    return Number(h);
  }

  /** Completed (non-refunded) orders in [range]; today only up to now. */
  private async orders(range: DateRange, includeRefunds = false): Promise<Order[]> {
    const today = await this.today();
    const to = range.to > today ? today : range.to;
    let from = range.from;
    if (daysBetween(from, to) > MAX_DAYS) from = addDays(to, -(MAX_DAYS - 1));
    const out: Order[] = [];
    const hourNow = this.currentHour();
    for (let day = from; day <= to; day = addDays(day, 1)) {
      for (const o of ordersForDay(day)) {
        if (day === today && o.hour > hourNow) continue;
        if (o.refunded && !includeRefunds) continue;
        out.push(o);
      }
    }
    return out;
  }

  async salesSummary(range: DateRange): Promise<SalesSummary> {
    const all = await this.orders(range, true);
    const orders = all.filter((o) => !o.refunded);
    const revenue = round2(orders.reduce((s, o) => s + o.total, 0));
    const pay = new Map<string, { amount: number; orders: number }>();
    for (const o of orders) {
      const p = pay.get(o.payment) ?? { amount: 0, orders: 0 };
      p.amount += o.total;
      p.orders++;
      pay.set(o.payment, p);
    }
    return {
      range,
      revenue,
      orders: orders.length,
      averageOrderValue: orders.length ? round2(revenue / orders.length) : 0,
      itemsSold: orders.reduce((s, o) => s + o.lines.reduce((q, l) => q + l.qty, 0), 0),
      discounts: round2(orders.reduce((s, o) => s + o.discount, 0)),
      tax: round2(revenue - revenue / 1.15),
      returns: round2(all.filter((o) => o.refunded).reduce((s, o) => s + o.total, 0)),
      paymentMethods: [...pay.entries()]
        .map(([method, v]) => ({ method, amount: round2(v.amount), orders: v.orders }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  async salesTrend(range: DateRange, granularity: Granularity): Promise<TrendPoint[]> {
    const buckets = new Map<string, TrendPoint>();
    const keyOf = (date: string) => {
      if (granularity === "month") return date.slice(0, 7);
      if (granularity === "week") return addDays(date, -((parseDate(date).getUTCDay() + 6) % 7));
      return date;
    };
    const today = await this.today();
    for (let day = range.from; day <= (range.to > today ? today : range.to); day = addDays(day, 1)) {
      const k = keyOf(day);
      if (!buckets.has(k)) buckets.set(k, { period: k, revenue: 0, orders: 0 });
    }
    for (const o of await this.orders(range)) {
      const b = buckets.get(keyOf(o.date))!;
      b.revenue += o.total;
      b.orders++;
    }
    return [...buckets.values()].map((b) => ({ ...b, revenue: round2(b.revenue) }));
  }

  private async productTotals(range: DateRange): Promise<Map<Product, { qty: number; revenue: number }>> {
    const totals = new Map<Product, { qty: number; revenue: number }>();
    for (const o of await this.orders(range)) {
      const factor = o.discount ? o.total / (o.total + o.discount) : 1;
      for (const l of o.lines) {
        const t = totals.get(l.product) ?? { qty: 0, revenue: 0 };
        t.qty += l.qty;
        t.revenue += l.amount * factor;
        totals.set(l.product, t);
      }
    }
    return totals;
  }

  async topProducts(range: DateRange, limit: number, by: "revenue" | "quantity"): Promise<ProductRow[]> {
    const rows = [...(await this.productTotals(range)).entries()].map(([p, t]) => ({
      name: p.name,
      category: p.category,
      quantity: t.qty,
      revenue: round2(t.revenue),
    }));
    rows.sort((a, b) => (by === "quantity" ? b.quantity - a.quantity : b.revenue - a.revenue));
    return limit > 0 ? rows.slice(0, limit) : rows.reverse().slice(0, -limit);
  }

  async categoryBreakdown(range: DateRange): Promise<CategoryRow[]> {
    const cats = new Map<string, { quantity: number; revenue: number }>();
    for (const [p, t] of await this.productTotals(range)) {
      const c = cats.get(p.category) ?? { quantity: 0, revenue: 0 };
      c.quantity += t.qty;
      c.revenue += t.revenue;
      cats.set(p.category, c);
    }
    const total = [...cats.values()].reduce((s, c) => s + c.revenue, 0) || 1;
    return [...cats.entries()]
      .map(([category, c]) => ({ category, quantity: c.quantity, revenue: round2(c.revenue), share: round2(c.revenue / total) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  async timePatterns(range: DateRange): Promise<{ hourly: HourlyRow[]; weekdays: WeekdayRow[] }> {
    const hourly: HourlyRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, orders: 0 }));
    const weekdays: WeekdayRow[] = WEEKDAYS.map((weekday) => ({ weekday, revenue: 0, orders: 0 }));
    for (const o of await this.orders(range)) {
      hourly[o.hour].revenue += o.total;
      hourly[o.hour].orders++;
      const w = weekdays[(parseDate(o.date).getUTCDay() + 6) % 7];
      w.revenue += o.total;
      w.orders++;
    }
    return {
      hourly: hourly.filter((h) => h.orders > 0).map((h) => ({ ...h, revenue: round2(h.revenue) })),
      weekdays: weekdays.map((w) => ({ ...w, revenue: round2(w.revenue) })),
    };
  }

  async stock(filter: "low" | "out" | "all", limit: number, search?: string) {
    const tracked = PRODUCTS.filter((p) => p.reorderLevel > 0);
    const rows: StockRow[] = tracked.map((p) => ({
      name: p.name,
      sku: `SKU-${String(1000 + p.id)}`,
      category: p.category,
      stock: p.stock,
      reorderLevel: p.reorderLevel,
      unit: p.unit,
      status: p.stock <= 0 ? "out" : p.stock <= p.reorderLevel ? "low" : "ok",
    }));
    const q = search?.trim().toLowerCase();
    const filtered = rows
      .filter((r) => (filter === "all" ? true : filter === "out" ? r.status === "out" : r.status !== "ok"))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.sku?.toLowerCase().includes(q))
      .sort((a, b) => a.stock / (a.reorderLevel || 1) - b.stock / (b.reorderLevel || 1));
    return {
      rows: filtered.slice(0, limit),
      totals: {
        products: rows.length,
        out: rows.filter((r) => r.status === "out").length,
        low: rows.filter((r) => r.status === "low").length,
      },
    };
  }

  async topCustomers(range: DateRange, limit: number): Promise<CustomerRow[]> {
    const agg = new Map<number, CustomerRow>();
    for (const o of await this.orders(range)) {
      if (o.customerId == null) continue;
      const c = CUSTOMERS[o.customerId - 1];
      const row = agg.get(c.id) ?? { name: c.name, phone: c.phone, orders: 0, revenue: 0, lastOrder: o.date };
      row.orders++;
      row.revenue += o.total;
      if (o.date > (row.lastOrder ?? "")) row.lastOrder = o.date;
      agg.set(c.id, row);
    }
    return [...agg.values()]
      .map((r) => ({ ...r, revenue: round2(r.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  async recentOrders(limit: number, search?: string): Promise<OrderRow[]> {
    const today = await this.today();
    const q = search?.trim().toLowerCase();
    const out: OrderRow[] = [];
    for (let day = today, n = 0; n < 60 && out.length < limit; day = addDays(day, -1), n++) {
      const list = (await this.orders({ from: day, to: day, label: day }, true)).slice().reverse();
      for (const o of list) {
        const customer = o.customerId ? CUSTOMERS[o.customerId - 1].name : "Walk-in customer";
        if (q && !o.number.toLowerCase().includes(q) && !customer.toLowerCase().includes(q)) continue;
        out.push({
          number: o.number,
          date: `${o.date} ${String(o.hour).padStart(2, "0")}:00`,
          customer,
          total: o.total,
          status: o.refunded ? "Refunded" : "Completed",
          payment: o.payment,
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
