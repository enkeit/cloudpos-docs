import type { DateRange } from "../period.ts";

export interface StoreInfo {
  mode: "live";
  company: string;
  store: string;
  currency: string;
  timeZone: string;
  user?: string;
  role?: string;
}

export interface SalesSummary {
  range: DateRange;
  revenue: number;
  orders: number;
  averageOrderValue: number;
  itemsSold?: number;
  discounts?: number;
  tax?: number;
  returns?: number;
  paymentMethods?: Array<{ method: string; amount: number; orders: number }>;
}

export interface TrendPoint {
  period: string; // YYYY-MM-DD (day/week start) or YYYY-MM (month)
  revenue: number;
  orders: number;
}

export interface ProductRow {
  name: string;
  category?: string;
  quantity: number;
  revenue: number;
}

export interface CategoryRow {
  category: string;
  quantity: number;
  revenue: number;
  share: number; // 0..1 of revenue
}

export interface StockRow {
  name: string;
  sku?: string;
  category?: string;
  stock: number;
  reorderLevel?: number;
  unit?: string;
  status: "out" | "low" | "ok";
}

export interface CustomerRow {
  name: string;
  phone?: string;
  orders: number;
  revenue: number;
  lastOrder?: string;
  balance?: number;
}

export interface OrderRow {
  number: string;
  date: string;
  customer: string;
  total: number;
  status?: string;
  payment?: string;
}

export interface HourlyRow {
  hour: number; // 0..23
  revenue: number;
  orders: number;
}

export interface WeekdayRow {
  weekday: string;
  revenue: number;
  orders: number;
}

export type Granularity = "day" | "week" | "month";

/** Thrown when a data source can't answer a question at all. */
export class UnsupportedError extends Error {}

/**
 * Read-only view of one store's data. Every method returns already
 * aggregated numbers: the model narrates, the code does the arithmetic.
 */
export interface DataSource {
  info(): Promise<StoreInfo>;
  today(): Promise<string>;
  salesSummary(range: DateRange): Promise<SalesSummary>;
  salesTrend(range: DateRange, granularity: Granularity): Promise<TrendPoint[]>;
  topProducts(range: DateRange, limit: number, by: "revenue" | "quantity"): Promise<ProductRow[]>;
  categoryBreakdown(range: DateRange): Promise<CategoryRow[]>;
  timePatterns(range: DateRange): Promise<{ hourly: HourlyRow[]; weekdays: WeekdayRow[] }>;
  stock(filter: "low" | "out" | "all", limit: number, search?: string): Promise<{ rows: StockRow[]; totals: { products: number; out: number; low: number } }>;
  topCustomers(range: DateRange, limit: number): Promise<CustomerRow[]>;
  recentOrders(limit: number, search?: string): Promise<OrderRow[]>;
}
