// Tools the model may call. Each returns a compact JSON result for the model
// plus optional chart/table "visuals" streamed straight to the chat UI, so
// numbers shown to the user always come from code, never from the model.

import { PERIODS, previousRange, resolvePeriod, type DateRange } from "./period.ts";
import { apiGetTool, checkReceiptTool, DIAGNOSTIC_TOOL_SPECS, storeSetupTool } from "./diagnostics.ts";
import { searchDocs } from "./docs.ts";
import { UnsupportedError, type DataSource, type Granularity } from "./sources/types.ts";

export interface Chart {
  kind: "chart";
  type: "bar" | "line" | "pie";
  title: string;
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
  format: "money" | "number";
  currency?: string;
}

export interface Table {
  kind: "table";
  title: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  money?: number[]; // indexes of money columns
  currency?: string;
}

/** A screenshot published in the CloudPOS docs (never a generated image). */
export interface DocImageVisual {
  kind: "image";
  src: string; // absolute URL on the docs site
  alt: string;
  page: string; // docs page title
  link: string; // docs page URL
}

export type Visual = Chart | Table | DocImageVisual;

export interface ToolOutput {
  result: unknown;
  visuals?: Visual[];
}

export interface ToolContext {
  /** The signed-in store; null for guests, who only get docs search. */
  source: DataSource | null;
  ai: Ai;
  docsIndex?: VectorizeIndex;
  docsBaseUrl: string;
  /**
   * Screenshots search_docs returned during this answer, by id. show_doc_image
   * only accepts these ids, so the model can never show an arbitrary URL.
   */
  docImages?: Map<string, Omit<DocImageVisual, "kind">>;
}

interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const periodParams = {
  period: {
    type: "string",
    enum: PERIODS,
    description: "Reporting period. Prefer a named period; use 'custom' with from/to only for explicit dates.",
  },
  from: { type: "string", description: "YYYY-MM-DD, only with period=custom" },
  to: { type: "string", description: "YYYY-MM-DD, only with period=custom" },
};

export const DATA_TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "get_sales_summary",
      description: "Revenue, order count, average order value (plus items, discounts, VAT, refunds and payment methods when available) for a period, compared with the previous equal-length period.",
      parameters: { type: "object", properties: { ...periodParams }, required: ["period"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sales_trend",
      description: "Revenue and orders over time, bucketed by day, week or month. Use for trends, growth, best/worst days.",
      parameters: {
        type: "object",
        properties: { ...periodParams, granularity: { type: "string", enum: ["day", "week", "month"] } },
        required: ["period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_products",
      description: "Best (or worst) selling products in a period by revenue or quantity.",
      parameters: {
        type: "object",
        properties: {
          ...periodParams,
          sort_by: { type: "string", enum: ["revenue", "quantity"] },
          order: { type: "string", enum: ["best", "worst"], description: "best = top sellers, worst = slowest movers" },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
        required: ["period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_category_breakdown",
      description: "Revenue and quantity per product category with share of total revenue.",
      parameters: { type: "object", properties: { ...periodParams }, required: ["period"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_busy_times",
      description: "Sales by hour of day and by weekday. Use for peak hours, staffing and opening-hours questions.",
      parameters: { type: "object", properties: { ...periodParams }, required: ["period"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_status",
      description: "Current stock levels: items that are out of stock, low (at or below reorder level), or all tracked items. Optional product name search.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["low", "out", "all"] },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["filter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_customers",
      description: "Highest-spending named customers in a period with order counts and last order date.",
      parameters: {
        type: "object",
        properties: { ...periodParams, limit: { type: "integer", minimum: 1, maximum: 25 } },
        required: ["period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_orders",
      description: "Most recent orders/invoices, optionally filtered by invoice number or customer name.",
      parameters: {
        type: "object",
        properties: { search: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } },
      },
    },
  },
];

export const DOCS_TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_docs",
      description: "Search the CloudPOS user documentation (POS app, admin panel, e-commerce). Use for any how-to, setup, feature or troubleshooting question.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "show_doc_image",
      description:
        "Show the user up to 3 screenshots from the CloudPOS docs. Only use image ids returned by search_docs in this conversation turn, and only when a screenshot shows the step or screen the user asked about.",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, maxItems: 3 } },
        required: ["ids"],
      },
    },
  },
];

/** Everything a signed-in user can call. */
export const TOOL_SPECS: ToolSpec[] = [...DATA_TOOL_SPECS, ...DIAGNOSTIC_TOOL_SPECS, ...DOCS_TOOL_SPECS];

const round2 = (n: number) => Math.round(n * 100) / 100;

function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

type DataContext = ToolContext & { source: DataSource };

async function rangeFrom(ctx: DataContext, args: Record<string, unknown>): Promise<DateRange> {
  return resolvePeriod(String(args.period ?? ""), await ctx.source.today(), { from: args.from, to: args.to });
}

function autoGranularity(range: DateRange): Granularity {
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  return days > 120 ? "month" : days > 45 ? "week" : "day";
}

export async function runTool(name: string, args: Record<string, unknown>, toolCtx: ToolContext): Promise<ToolOutput> {
  if (name === "search_docs") return searchDocsTool(args, toolCtx);
  if (name === "show_doc_image") return showDocImageTool(args, toolCtx);
  if (!toolCtx.source) {
    return { result: { error: "Store data is only available after signing in to CloudPOS.", sign_in_required: true } };
  }
  const ctx = toolCtx as DataContext;
  if (name === "api_get") return { result: await apiGetTool(ctx.source, args) };
  if (name === "check_receipt") return { result: await checkReceiptTool(ctx.source, args) };
  if (name === "get_store_setup") return { result: await storeSetupTool(ctx.source) };
  const info = await ctx.source.info();
  const currency = info.currency || undefined;
  try {
    switch (name) {
      case "get_sales_summary": {
        const range = await rangeFrom(ctx, args);
        const prev = previousRange(range);
        const [now, before] = await Promise.all([ctx.source.salesSummary(range), ctx.source.salesSummary(prev)]);
        return {
          result: {
            currency,
            current: now,
            previous: { range: prev, revenue: before.revenue, orders: before.orders, averageOrderValue: before.averageOrderValue },
            change_pct: {
              revenue: pctChange(now.revenue, before.revenue),
              orders: pctChange(now.orders, before.orders),
              averageOrderValue: pctChange(now.averageOrderValue, before.averageOrderValue),
            },
          },
          visuals: now.paymentMethods?.length
            ? [{ kind: "chart", type: "pie", title: `Payment methods · ${range.label}`, labels: now.paymentMethods.map((p) => p.method), series: [{ name: "Revenue", data: now.paymentMethods.map((p) => p.amount) }], format: "money", currency }]
            : undefined,
        };
      }
      case "get_sales_trend": {
        const range = await rangeFrom(ctx, args);
        const g = (["day", "week", "month"] as const).includes(args.granularity as Granularity) ? (args.granularity as Granularity) : autoGranularity(range);
        const points = await ctx.source.salesTrend(range, g);
        const best = points.reduce((a, b) => (b.revenue > a.revenue ? b : a), points[0]);
        const worst = points.reduce((a, b) => (b.revenue < a.revenue ? b : a), points[0]);
        const total = round2(points.reduce((s, p) => s + p.revenue, 0));
        return {
          result: {
            currency,
            range,
            granularity: g,
            total_revenue: total,
            average_per_bucket: points.length ? round2(total / points.length) : 0,
            best,
            worst,
            points: points.length > 60 ? points.slice(-60) : points,
          },
          visuals: [{ kind: "chart", type: points.length > 14 ? "line" : "bar", title: `Revenue by ${g} · ${range.label}`, labels: points.map((p) => p.period), series: [{ name: "Revenue", data: points.map((p) => p.revenue) }], format: "money", currency }],
        };
      }
      case "get_top_products": {
        const range = await rangeFrom(ctx, args);
        const by = args.sort_by === "quantity" ? "quantity" : "revenue";
        const limit = clampInt(args.limit, 1, 25, 10);
        const rows = await ctx.source.topProducts(range, args.order === "worst" ? -limit : limit, by);
        return {
          result: { currency, range, sort_by: by, order: args.order === "worst" ? "worst" : "best", products: rows },
          visuals: rows.length
            ? [{ kind: "chart", type: "bar", title: `${args.order === "worst" ? "Slowest" : "Top"} products by ${by} · ${range.label}`, labels: rows.map((r) => r.name), series: [{ name: by === "quantity" ? "Units" : "Revenue", data: rows.map((r) => (by === "quantity" ? r.quantity : r.revenue)) }], format: by === "quantity" ? "number" : "money", currency }]
            : undefined,
        };
      }
      case "get_category_breakdown": {
        const range = await rangeFrom(ctx, args);
        const rows = await ctx.source.categoryBreakdown(range);
        return {
          result: { currency, range, categories: rows },
          visuals: rows.length ? [{ kind: "chart", type: "pie", title: `Revenue by category · ${range.label}`, labels: rows.map((r) => r.category), series: [{ name: "Revenue", data: rows.map((r) => r.revenue) }], format: "money", currency }] : undefined,
        };
      }
      case "get_busy_times": {
        const range = await rangeFrom(ctx, args);
        const { hourly, weekdays } = await ctx.source.timePatterns(range);
        const label = (h: number) => `${String(h).padStart(2, "0")}:00`;
        const visuals: Visual[] = [];
        if (hourly.length) visuals.push({ kind: "chart", type: "bar", title: `Orders by hour · ${range.label}`, labels: hourly.map((h) => label(h.hour)), series: [{ name: "Orders", data: hourly.map((h) => h.orders) }], format: "number" });
        // A weekday split only means something once the range covers a full week.
        if ((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 >= 6) visuals.push({ kind: "chart", type: "bar", title: `Revenue by weekday · ${range.label}`, labels: weekdays.map((w) => w.weekday.slice(0, 3)), series: [{ name: "Revenue", data: weekdays.map((w) => w.revenue) }], format: "money", currency });
        const peak = [...hourly].sort((a, b) => b.orders - a.orders).slice(0, 3);
        return {
          result: { currency, range, peak_hours: peak.map((h) => ({ hour: label(h.hour), orders: h.orders, revenue: h.revenue })), hourly: hourly.map((h) => ({ hour: label(h.hour), orders: h.orders })), weekdays, hourly_available: hourly.length > 0 },
          visuals,
        };
      }
      case "get_stock_status": {
        const filter = args.filter === "out" || args.filter === "all" ? args.filter : "low";
        const limit = clampInt(args.limit, 1, 50, 20);
        const { rows, totals } = await ctx.source.stock(filter, limit, typeof args.search === "string" ? args.search : undefined);
        return {
          result: { filter, totals, items: rows },
          visuals: rows.length
            ? [{ kind: "table", title: filter === "out" ? "Out of stock" : filter === "low" ? "Low & out of stock" : "Stock levels", columns: ["Product", "SKU", "Stock", "Reorder at", "Status"], rows: rows.map((r) => [r.name, r.sku ?? "", `${r.stock}${r.unit ? ` ${r.unit}` : ""}`, r.reorderLevel ?? "", r.status === "out" ? "Out" : r.status === "low" ? "Low" : "OK"]) }]
            : undefined,
        };
      }
      case "get_top_customers": {
        const range = await rangeFrom(ctx, args);
        const rows = await ctx.source.topCustomers(range, clampInt(args.limit, 1, 25, 10));
        return {
          result: { currency, range, customers: rows.map(({ phone: _p, ...r }) => r) },
          visuals: rows.length ? [{ kind: "table", title: `Top customers · ${range.label}`, columns: ["Customer", "Orders", "Spent", "Last order"], rows: rows.map((r) => [r.name, r.orders, r.revenue, r.lastOrder ?? ""]), money: [2], currency }] : undefined,
        };
      }
      case "find_orders": {
        const rows = await ctx.source.recentOrders(clampInt(args.limit, 1, 25, 10), typeof args.search === "string" ? args.search : undefined);
        return {
          result: { currency, orders: rows },
          visuals: rows.length ? [{ kind: "table", title: "Orders", columns: ["Invoice", "Date", "Customer", "Total", "Payment", "Status"], rows: rows.map((r) => [r.number, r.date, r.customer, r.total, r.payment ?? "", r.status ?? ""]), money: [3], currency }] : undefined,
        };
      }
      default:
        return { result: { error: `Unknown tool ${name}` } };
    }
  } catch (error) {
    if (error instanceof UnsupportedError) return { result: { error: error.message, unsupported: true } };
    throw error;
  }
}

async function searchDocsTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  if (!ctx.docsIndex) return { result: { error: "Documentation search is not configured." } };
  const hits = await searchDocs(ctx.ai, ctx.docsIndex, String(args.query ?? "").slice(0, 500));
  const registry = (ctx.docImages ??= new Map());
  return {
    result: {
      results: hits.map((h) => {
        const link = `${ctx.docsBaseUrl}${h.url}`;
        const images = h.images.flatMap((img) => {
          const src = docImageUrl(img.src, ctx.docsBaseUrl);
          if (!src) return [];
          const id = `img${registry.size + 1}`;
          registry.set(id, { src, alt: img.alt, page: h.title, link });
          return [{ id, description: img.alt || "Screenshot" }];
        });
        return { link, page: h.title, section: h.heading, text: h.text, ...(images.length ? { images } : {}) };
      }),
      note: hits.length ? undefined : "No matching documentation found.",
    },
  };
}

/** Site paths become docs-site URLs; absolute URLs must already be on the docs site. */
export function docImageUrl(src: string, docsBaseUrl: string): string | null {
  const base = docsBaseUrl.replace(/\/+$/, "");
  if (/^\/(?!\/)/.test(src)) return `${base}${src}`;
  return src.startsWith(`${base}/`) ? src : null;
}

function showDocImageTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutput {
  const ids = Array.isArray(args.ids) ? args.ids.map(String).slice(0, 3) : [];
  const found = ids.map((id) => ({ id, image: ctx.docImages?.get(id) }));
  const visuals: Visual[] = found.flatMap((f) => (f.image ? [{ kind: "image" as const, ...f.image }] : []));
  const unknown = found.filter((f) => !f.image).map((f) => f.id);
  return {
    result: {
      shown: visuals.length,
      ...(unknown.length ? { error: `Unknown image ids: ${unknown.join(", ")}. Only ids returned by search_docs can be shown.` } : {}),
    },
    visuals,
  };
}
