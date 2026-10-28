// Reads a real tenant's data from the CloudPOS Laravel API with the signed-in
// user's own token, so the assistant can never see more than that user can.
// Response shapes mirror what the Flutter app parses (lib/resources/app_url.dart).

import { addDays, parseDate, todayIn, type DateRange } from "../period.ts";
import type {
  ApiResponse,
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
  TaxIds,
  TrendPoint,
  WeekdayRow,
} from "./types.ts";

export interface LiveSession {
  domain: string; // https://tenant.example.com
  tenantKey: string;
  accessToken: string;
  /** CloudPOS user id; keys this user's chat history. */
  userId?: number;
  storeId?: number;
  storeName?: string;
  company?: string;
  user?: string;
  role?: string;
  timeZone?: string;
  stores?: Array<{ id: number; name: string }>;
  /** Company ZATCA numbers printed on receipts, and where they came from. */
  vatNumber?: string;
  crNumber?: string;
  taxIdsFrom?: "sign_in" | "app";
}

type Json = Record<string, unknown>;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_PAGES = 8;
/** Orders-list fallback: pages of up to 100 orders read per question. */
const MAX_ORDER_PAGES = 30;

type SaleRow = { date: string; hour: number | undefined; customer: string; total: number };
const round2 = (n: number) => Math.round(n * 100) / 100;

export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Rows out of the API's several list envelopes: data[], data.data[]. */
export function rowsOf(payload: unknown): Json[] {
  const data = (payload as Json | null)?.data;
  if (Array.isArray(data)) return data as Json[];
  const inner = (data as Json | null)?.data;
  return Array.isArray(inner) ? (inner as Json[]) : [];
}

export function lastPageOf(payload: unknown): number {
  const p = payload as Json | null;
  const data = (p?.data ?? {}) as Json;
  const pagination = (data.pagination ?? p?.pagination ?? data) as Json;
  return Math.max(1, num(pagination.last_page) || 1);
}

/** "2026-10-27 14:05:00" / "2026-10-27T14:05:00Z" / "27-10-2026" → parts. */
export function parseApiDate(value: unknown): { date: string; hour?: number } | null {
  const s = str(value);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):\d{2})?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, hour: m[4] != null ? Number(m[4]) : undefined };
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})(?:\s+(\d{1,2}):\d{2}\s*([AaPp][Mm])?)?/);
  if (m) {
    let hour = m[4] != null ? Number(m[4]) : undefined;
    if (hour != null && m[5]) hour = (hour % 12) + (/p/i.test(m[5]) ? 12 : 0);
    return { date: `${m[3]}-${m[2]}-${m[1]}`, hour };
  }
  return null;
}

export class LiveApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class LiveSource implements DataSource {
  private currency = "";
  private salesCache = new Map<string, SaleRow[]>();

  private readonly session: LiveSession;
  private readonly fetcher: typeof fetch;

  constructor(session: LiveSession, fetcher?: typeof fetch) {
    this.session = session;
    // Calling a stored global fetch as a method throws "Illegal invocation" on Workers.
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  private async get(path: string, query: Record<string, string | number | undefined>, withStore = true): Promise<Json> {
    const url = new URL(path, this.session.domain);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    if (withStore && this.session.storeId != null) url.searchParams.set("store_id", String(this.session.storeId));
    const res = await this.fetcher(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.session.accessToken}`,
        "X-Tenant": this.session.tenantKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) throw new LiveApiError("Your CloudPOS session has expired. Please sign in again.", res.status);
    let payload: Json | null = null;
    try {
      payload = (await res.json()) as Json;
    } catch {
      payload = null;
    }
    // The orders endpoint answers an empty result with HTTP 500 "No Orders Found".
    if (res.status === 500 && /no .*found/i.test(str(payload?.message))) return { data: [] };
    if (!res.ok || payload == null) throw new LiveApiError(`CloudPOS API ${url.pathname} failed (HTTP ${res.status}).`, res.status);
    return payload;
  }

  async apiGet(path: string, query: Record<string, string>): Promise<ApiResponse> {
    if (!/^\/api\/v1\/[\w\-/%.]+$/.test(path) || path.includes("..")) return { status: 400, body: { message: "Path not allowed." } };
    const url = new URL(path, this.session.domain);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (this.session.storeId != null) url.searchParams.set("store_id", String(this.session.storeId));
    const res = await this.fetcher(url.toString(), {
      headers: { Authorization: `Bearer ${this.session.accessToken}`, "X-Tenant": this.session.tenantKey, Accept: "application/json" },
    });
    if (res.status === 401) throw new LiveApiError("Your CloudPOS session has expired. Please sign in again.", res.status);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: /pdf|octet-stream/i.test(res.headers.get("Content-Type") ?? "") ? "Not JSON (a file)." : text.slice(0, 300) };
    }
    return { status: res.status, body };
  }

  async taxIds(): Promise<TaxIds> {
    const s = this.session;
    return { vatNumber: s.vatNumber, crNumber: s.crNumber, source: s.taxIdsFrom ?? "unknown" };
  }

  async info(): Promise<StoreInfo> {
    return {
      mode: "live",
      company: this.session.company || "Your company",
      store: this.session.storeName || (this.session.storeId != null ? `Store #${this.session.storeId}` : "All stores"),
      currency: this.currency,
      timeZone: this.session.timeZone || "Asia/Riyadh",
      user: this.session.user,
      role: this.session.role,
    };
  }

  async today(): Promise<string> {
    return todayIn(this.session.timeZone || "Asia/Riyadh");
  }

  /** Set when the orders fallback hit its page cap, so totals may be partial. */
  private salesPartial = new Set<string>();

  /**
   * One row per sale. Prefers /reports/sales-report (one call); tenants whose
   * server lacks it (HTTP 404) are served from the orders list instead.
   */
  private async sales(range: DateRange) {
    const key = `${range.from}|${range.to}`;
    const cached = this.salesCache.get(key);
    if (cached) return cached;
    let rows: SaleRow[];
    try {
      rows = await this.salesFromReport(range);
    } catch (error) {
      if (!(error instanceof LiveApiError) || (error.status !== 404 && error.status !== 405)) throw error;
      rows = await this.salesFromOrders(range, key);
    }
    this.salesCache.set(key, rows);
    return rows;
  }

  private async salesFromReport(range: DateRange): Promise<SaleRow[]> {
    const payload = await this.get("/api/v1/reports/sales-report", { from_date: range.from, to_date: range.to });
    return (Array.isArray(payload.data) ? (payload.data as Json[]) : rowsOf(payload))
      .map((r) => {
        const d = parseApiDate(r.date ?? r.order_date ?? r.created_at);
        return d ? { date: d.date, hour: d.hour, customer: str(r.customer_name) || "Walk-in customer", total: num(r.total_price ?? r.grand_total) } : null;
      })
      .filter((r): r is SaleRow => r != null && r.date >= range.from && r.date <= range.to);
  }

  /** Same filters the Orders screen uses; cancelled and returned orders don't count as sales. */
  private async salesFromOrders(range: DateRange, key: string): Promise<SaleRow[]> {
    const out: SaleRow[] = [];
    for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
      const payload = await this.get("/api/v1/order/executive/list-orders", {
        page,
        per_page: 100,
        filter_store: this.session.storeId,
        "filter_datetime[from]": `${range.from} 00:00:00`,
        "filter_datetime[until]": `${range.to} 23:59:59`,
      });
      const rows = rowsOf(payload);
      let olderThanRange = 0;
      for (const r of rows) {
        const d = parseApiDate(r.order_date ?? r.issued_at ?? r.created_at);
        if (!d) continue;
        if (d.date < range.from) olderThanRange++;
        if (d.date < range.from || d.date > range.to) continue;
        if (/cancel|return|refund|void/i.test(str(r.status))) continue;
        out.push({ date: d.date, hour: d.hour, customer: str(r.customer_name) || "Walk-in customer", total: num(r.grand_total) });
      }
      const data = (payload.data ?? {}) as Json;
      const last = num(data.last_page);
      const more = last ? page < last : !!data.next_page_url;
      // Orders come newest first; a page entirely before the range means we're done.
      if (!rows.length || !more || (rows.length && olderThanRange === rows.length)) return out;
      if (page === MAX_ORDER_PAGES) this.salesPartial.add(key);
    }
    return out;
  }

  async salesSummary(range: DateRange): Promise<SalesSummary> {
    const rows = await this.sales(range);
    const revenue = round2(rows.reduce((s, r) => s + r.total, 0));
    return {
      range,
      revenue,
      orders: rows.length,
      averageOrderValue: rows.length ? round2(revenue / rows.length) : 0,
      ...(this.salesPartial.has(`${range.from}|${range.to}`)
        ? { note: `Based on the most recent ${rows.length} orders only; the period has more orders than could be read at once.` }
        : {}),
    };
  }

  async salesTrend(range: DateRange, granularity: Granularity): Promise<TrendPoint[]> {
    const keyOf = (date: string) =>
      granularity === "month" ? date.slice(0, 7) : granularity === "week" ? addDays(date, -((parseDate(date).getUTCDay() + 6) % 7)) : date;
    const buckets = new Map<string, TrendPoint>();
    const today = await this.today();
    for (let d = range.from; d <= (range.to > today ? today : range.to); d = addDays(d, 1)) {
      const k = keyOf(d);
      if (!buckets.has(k)) buckets.set(k, { period: k, revenue: 0, orders: 0 });
    }
    for (const r of await this.sales(range)) {
      const b = buckets.get(keyOf(r.date));
      if (!b) continue;
      b.revenue += r.total;
      b.orders++;
    }
    return [...buckets.values()].map((b) => ({ ...b, revenue: round2(b.revenue) }));
  }

  private async productRows(range: DateRange): Promise<ProductRow[]> {
    const out: ProductRow[] = [];
    for (let page = 1, last = 1; page <= last && page <= MAX_PAGES; page++) {
      const payload = await this.get("/api/v1/product-sales-report", { from: range.from, to: range.to, page, per_page: 250 }, false);
      const data = (payload.data ?? {}) as Json;
      if (typeof data.currency === "string" && data.currency) this.currency = data.currency;
      for (const r of rowsOf(payload)) {
        out.push({
          name: str(r.product_name) || `Product #${str(r.product_id)}`,
          category: str(r.category) || undefined,
          quantity: num(r.sales_count),
          revenue: round2(num(r.total_price)),
        });
      }
      last = num(((data.pagination ?? {}) as Json).last_page) || 1;
    }
    return out;
  }

  async topProducts(range: DateRange, limit: number, by: "revenue" | "quantity"): Promise<ProductRow[]> {
    const rows = await this.productRows(range);
    rows.sort((a, b) => (by === "quantity" ? b.quantity - a.quantity : b.revenue - a.revenue));
    return limit > 0 ? rows.slice(0, limit) : rows.reverse().slice(0, -limit);
  }

  async categoryBreakdown(range: DateRange): Promise<CategoryRow[]> {
    const cats = new Map<string, { quantity: number; revenue: number }>();
    for (const r of await this.productRows(range)) {
      const k = r.category || "Uncategorised";
      const c = cats.get(k) ?? { quantity: 0, revenue: 0 };
      c.quantity += r.quantity;
      c.revenue += r.revenue;
      cats.set(k, c);
    }
    const total = [...cats.values()].reduce((s, c) => s + c.revenue, 0) || 1;
    return [...cats.entries()]
      .map(([category, c]) => ({ category, quantity: c.quantity, revenue: round2(c.revenue), share: round2(c.revenue / total) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  async timePatterns(range: DateRange): Promise<{ hourly: HourlyRow[]; weekdays: WeekdayRow[] }> {
    const hourly: HourlyRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, orders: 0 }));
    const weekdays: WeekdayRow[] = WEEKDAYS.map((weekday) => ({ weekday, revenue: 0, orders: 0 }));
    for (const r of await this.sales(range)) {
      if (r.hour != null) {
        hourly[r.hour].revenue += r.total;
        hourly[r.hour].orders++;
      }
      const w = weekdays[(parseDate(r.date).getUTCDay() + 6) % 7];
      w.revenue += r.total;
      w.orders++;
    }
    return {
      hourly: hourly.filter((h) => h.orders > 0).map((h) => ({ ...h, revenue: round2(h.revenue) })),
      weekdays: weekdays.map((w) => ({ ...w, revenue: round2(w.revenue) })),
    };
  }

  async stock(filter: "low" | "out" | "all", limit: number, search?: string) {
    const payload = await this.get("/api/v1/product/list-stocks", { page: 1, per_page: 1000, filter_name: search?.trim() || undefined });
    const rows: StockRow[] = rowsOf(payload).map((r) => {
      const stock = num(r.qty);
      const reorderLevel = num(r.reorder_level);
      return {
        name: [str(r.product_name), str(r.variant_name)].filter((x, i, a) => x && a.indexOf(x) === i).join(" – ") || "Unnamed product",
        sku: str(r.barcode) || undefined,
        category: str(r.category_name) || undefined,
        stock,
        reorderLevel: reorderLevel || undefined,
        unit: str(r.unit) || undefined,
        status: stock <= 0 ? "out" : reorderLevel > 0 && stock <= reorderLevel ? "low" : "ok",
      };
    });
    const filtered = rows
      .filter((r) => (filter === "all" ? true : filter === "out" ? r.status === "out" : r.status !== "ok"))
      .sort((a, b) => a.stock - b.stock);
    return {
      rows: filtered.slice(0, limit),
      totals: { products: rows.length, out: rows.filter((r) => r.status === "out").length, low: rows.filter((r) => r.status === "low").length },
    };
  }

  async topCustomers(range: DateRange, limit: number): Promise<CustomerRow[]> {
    const agg = new Map<string, CustomerRow>();
    for (const r of await this.sales(range)) {
      if (/^walk[- ]?in/i.test(r.customer)) continue;
      const row = agg.get(r.customer) ?? { name: r.customer, orders: 0, revenue: 0, lastOrder: r.date };
      row.orders++;
      row.revenue += r.total;
      if (r.date > (row.lastOrder ?? "")) row.lastOrder = r.date;
      agg.set(r.customer, row);
    }
    return [...agg.values()]
      .map((r) => ({ ...r, revenue: round2(r.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  async recentOrders(limit: number, search?: string): Promise<OrderRow[]> {
    const q = search?.trim();
    const looksLikeNumber = !!q && /\d/.test(q) && !/\s/.test(q);
    const payload = await this.get("/api/v1/order/executive/list-orders", {
      page: 1,
      filter_store: this.session.storeId,
      number: looksLikeNumber ? q!.toUpperCase() : undefined,
      filter_name: q && !looksLikeNumber ? q : undefined,
    });
    return rowsOf(payload)
      .slice(0, limit)
      .map((r) => ({
        number: str(r.order_number) || str(r.receipt_number) || `#${str(r.id)}`,
        date: str(r.order_date),
        customer: str(r.customer_name) || "Walk-in customer",
        total: round2(num(r.grand_total)),
        status: str(r.status) || str(r.payment_status) || undefined,
        payment: Array.isArray(r.payment_method) ? r.payment_method.map(str).join(", ") : str(r.payment_method) || undefined,
      }));
  }
}

// ---- Sign-in ---------------------------------------------------------------

const FIND_DOMAIN_URL = "https://cloudposai.com/api/v1/find-domain";

export function normalizeDomain(raw: string): string {
  let d = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(d)) d = `https://${d}`;
  const url = new URL(d);
  if (url.protocol !== "https:") throw new Error("Tenant domain must use HTTPS.");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname) || !url.hostname.includes(".")) {
    throw new Error("Tenant domain is not a public host.");
  }
  return url.origin;
}

/** Tenant API key → tenant base URL, the same lookup the app's login does. */
export async function findDomain(tenantKey: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(FIND_DOMAIN_URL, {
    method: "POST",
    headers: { "X-Tenant-Key": tenantKey.trim(), Accept: "application/json" },
  });
  let payload: Json | null = null;
  try {
    payload = (await res.json()) as Json;
  } catch {
    payload = null;
  }
  const domain = str(((payload?.data ?? {}) as Json).domain);
  if (!res.ok || !domain) throw new LiveApiError(str(payload?.message) || "That company key was not recognised.", res.status || 400);
  return normalizeDomain(domain);
}

/**
 * Turns the POS app's existing login (tenant key + access token) into a
 * session without asking for the password again. The token is proven by
 * calling the tenant's own API with it; the user id comes from that response,
 * never from the app. Store and company names are display-only hints.
 */
export async function sessionFromAppToken(
  input: {
    tenantKey: string;
    accessToken: string;
    storeId?: number;
    hints?: { company?: string; role?: string; timeZone?: string; stores?: Array<{ id: number; name: string }>; vatNumber?: string; crNumber?: string };
  },
  fetcher: typeof fetch = fetch,
): Promise<LiveSession> {
  const domain = await findDomain(input.tenantKey, fetcher);
  const url = new URL("/api/v1/dashboard", domain);
  if (input.storeId) url.searchParams.set("store_id", String(input.storeId));
  const res = await fetcher(url.toString(), {
    headers: { Authorization: `Bearer ${input.accessToken}`, "X-Tenant": input.tenantKey.trim(), Accept: "application/json" },
  });
  let payload: Json | null = null;
  try {
    payload = (await res.json()) as Json;
  } catch {
    payload = null;
  }
  const profiles = ((payload?.data ?? {}) as Json).profile_details;
  const profile = (Array.isArray(profiles) ? profiles[0] : null) as Json | null;
  const userId = num(profile?.id);
  if (!res.ok || !userId) throw new LiveApiError("Your CloudPOS login could not be verified. Please sign in again.", res.status === 200 ? 401 : res.status || 401);
  const clip = (v: unknown, n = 80) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, n) : "") || undefined;
  const stores = (input.hints?.stores ?? [])
    .map((s) => ({ id: num(s?.id), name: clip(s?.name) ?? "" }))
    .filter((s) => s.id > 0)
    .slice(0, 50);
  return {
    domain,
    tenantKey: input.tenantKey.trim(),
    accessToken: input.accessToken,
    userId,
    user: clip(profile?.name),
    storeId: input.storeId,
    storeName: stores.find((s) => s.id === input.storeId)?.name,
    company: clip(input.hints?.company),
    role: clip(input.hints?.role, 40),
    timeZone: clip(input.hints?.timeZone, 64),
    stores,
    // What the app saved at its own sign-in; the receipt check says so. Older
    // apps send neither key, and then the numbers are unknown, not empty.
    vatNumber: taxId(input.hints?.vatNumber),
    crNumber: taxId(input.hints?.crNumber),
    taxIdsFrom: input.hints && ("vatNumber" in input.hints || "crNumber" in input.hints) ? "app" : undefined,
  };
}

/** A VAT/CR number hint: digits, letters, spaces and dashes only. */
function taxId(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z -]{1,32}$/.test(v) ? v : undefined;
}

export interface SignInResult {
  session: LiveSession;
  stores: Array<{ id: number; name: string }>;
}

export async function signIn(
  input: { tenantKey: string; email: string; password: string; storeId?: number },
  fetcher: typeof fetch = fetch,
): Promise<SignInResult> {
  const domain = await findDomain(input.tenantKey, fetcher);
  const res = await fetcher(`${domain}/api/v1/user/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Tenant": input.tenantKey.trim() },
    body: JSON.stringify({ email: input.email.trim(), password: input.password }),
  });
  let payload: Json | null = null;
  try {
    payload = (await res.json()) as Json;
  } catch {
    payload = null;
  }
  const data = (payload?.data ?? null) as Json | null;
  const token = str(data?.access_token);
  if (!res.ok || !token) throw new LiveApiError(str(payload?.message) || "Sign-in failed. Check your email and password.", res.status || 401);
  const stores = (Array.isArray(data?.stores) ? (data!.stores as Json[]) : [])
    .map((s) => ({ id: num(s.store_id ?? s.id), name: str(s.store_name ?? s.name) }))
    .filter((s) => s.id > 0);
  const chosen = stores.find((s) => s.id === input.storeId) ?? stores[0];
  return {
    stores,
    session: {
      domain,
      tenantKey: input.tenantKey.trim(),
      accessToken: token,
      storeId: chosen?.id,
      storeName: chosen?.name,
      company: str(data?.company_name) || undefined,
      userId: num(data?.user_id) || undefined,
      user: str(data?.name) || undefined,
      role: str(data?.user_role) || undefined,
      timeZone: str(data?.time_zone) || undefined,
      stores,
      vatNumber: str(data?.vat_number) || undefined,
      crNumber: str(data?.cr_number) || undefined,
      taxIdsFrom: "sign_in",
    },
  };
}
