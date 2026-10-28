// Tiny fixed DataSource for tests only; never shipped to users.

import type { DateRange } from "../src/period.ts";
import type { ApiResponse, DataSource, Granularity, StoreInfo, TaxIds } from "../src/sources/types.ts";

export class FixtureSource implements DataSource {
  async info(): Promise<StoreInfo> {
    return { mode: "live", company: "Test Co", store: "Main", currency: "SAR", timeZone: "Asia/Riyadh" };
  }
  async today() {
    return "2026-10-27";
  }
  async salesSummary(range: DateRange) {
    const revenue = range.from === "2026-10-19" ? 1200 : 1000;
    return { range, revenue, orders: 40, averageOrderValue: revenue / 40, paymentMethods: [{ method: "Cash", amount: revenue, orders: 40 }] };
  }
  async salesTrend(range: DateRange, _g: Granularity) {
    return [{ period: range.from, revenue: 500, orders: 20 }, { period: range.to, revenue: 700, orders: 20 }];
  }
  async topProducts(_r: DateRange, limit: number) {
    return [{ name: "Tea", category: "Drinks", quantity: 10, revenue: 80 }].slice(0, Math.abs(limit));
  }
  async categoryBreakdown() {
    return [{ category: "Drinks", quantity: 10, revenue: 80, share: 1 }];
  }
  async timePatterns() {
    return { hourly: [{ hour: 9, revenue: 80, orders: 10 }], weekdays: [{ weekday: "Monday", revenue: 80, orders: 10 }] };
  }
  async stock() {
    return { rows: [{ name: "Milk", stock: 2, reorderLevel: 5, status: "low" as const }], totals: { products: 1, out: 0, low: 1 } };
  }
  async topCustomers() {
    return [{ name: "Ali", orders: 2, revenue: 150 }];
  }
  async recentOrders() {
    return [{ number: "INV-1", date: "2026-10-27", customer: "Ali", total: 50 }];
  }

  /** Canned API responses by path; every call is recorded. */
  responses: Record<string, ApiResponse> = {};
  calls: Array<{ path: string; query: Record<string, string> }> = [];
  ids: TaxIds = { source: "unknown" };

  async apiGet(path: string, query: Record<string, string>): Promise<ApiResponse> {
    this.calls.push({ path, query });
    return this.responses[path] ?? { status: 404, body: { message: "Not found" } };
  }
  async taxIds() {
    return this.ids;
  }
}
