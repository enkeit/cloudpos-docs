import assert from "node:assert/strict";
import { test } from "node:test";

import { ENDPOINTS, fit, redact, requestFor } from "../src/diagnostics.ts";
import { LiveSource, sessionFromAppToken } from "../src/sources/live.ts";
import { runTool, TOOL_SPECS, type ToolContext } from "../src/tools.ts";
import { FixtureSource } from "./fixture-source.ts";

const ctxFor = (source: FixtureSource): ToolContext => ({ source, ai: {} as Ai, docsBaseUrl: "https://docs.example.com" });

test("the allowlist leaves out GETs that create, reserve or sync", () => {
  const paths = Object.values(ENDPOINTS).map((e) => e.path).join(" ");
  for (const banned of ["generate-barcode", "generate-sku", "customer/profile", "apply-coupon", "fetch-waybill", "create-order", "pos-sync", "sync/changes", "verify-api-key", "search-user-by-key", "/documents/"]) {
    assert.ok(!paths.includes(banned), `${banned} must not be readable`);
  }
  assert.ok(TOOL_SPECS.some((t) => t.function.name === "api_get"));
});

test("api_get builds only allowlisted requests", () => {
  assert.deepEqual(requestFor("order_details", "ORD-002649", {}), { path: "/api/v1/order/executive/order-details/ORD-002649", query: {} });
  assert.ok("error" in requestFor("order_details", "../../admin", {}));
  assert.ok("error" in requestFor("not_a_thing", undefined, {}));
  // Unknown params are dropped, per_page is capped, fixed params always apply.
  assert.deepEqual(requestFor("expenses", undefined, { page: 2, per_page: 900, store_id: 99, evil: "x" }), {
    path: "/api/v1/general-payment/list-general-payments",
    query: { type: "EXPENSE", page: "2", per_page: "50" },
  });
  assert.deepEqual(requestFor("customers", undefined, { filter_name: "محمد" }), { path: "/api/v1/customer/customer-searchbar", query: { filter_name: "محمد" } });
});

test("secrets are removed, contacts masked, debug traces dropped, order tokens kept", () => {
  const out = redact({
    company: { api_key: "abc123", name: "Funz" },
    access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig",
    token_number: "17",
    showTokenNumber: { visible: true },
    invoice_hash: "ff8bbaa67ff88d3306829bff993c3ff8bbaa67ff88d3306829bff993c3",
    customer_details: { email: "ali@example.com", phone: "0501234567" },
    logo: "https://shop.example.com/logo.png?X-Amz-Signature=secret",
    has_password: true,
    trace: [{ file: "/var/www" }],
    message: "ok",
  }) as Record<string, any>;
  assert.equal(out.company.api_key, "[removed]");
  assert.equal(out.company.name, "Funz");
  assert.equal(out.access_token, "[removed]");
  assert.equal(out.token_number, "17");
  assert.deepEqual(out.showTokenNumber, { visible: true });
  assert.equal(out.invoice_hash, "[removed]");
  assert.equal(out.customer_details.email, "a•••@example.com");
  assert.equal(out.customer_details.phone, "•••567");
  assert.equal(out.logo, "https://shop.example.com/logo.png");
  assert.equal(out.has_password, true);
  assert.equal(out.trace, undefined);
  assert.ok(!JSON.stringify(out).includes("abc123"));
});

test("large responses are trimmed to fit", () => {
  const big = { data: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Product ${i}`, description: "x".repeat(400) })) };
  const { value, trimmed } = fit(big);
  assert.ok(trimmed);
  assert.ok(JSON.stringify(value).length <= 6000);
  assert.equal(fit({ a: 1 }).trimmed, false);
});

const BILL = {
  status: 200,
  body: {
    document_configurations: {
      Bill: {
        template: "bill",
        language: "en_ar",
        logo: "https://shop.example.com/logo.png",
        show_logo: 1,
        display_configuration: {
          showVatNumber: { visible: false, value: "VAT" },
          showCRNumber: { visible: true, value: "CR" },
          showCustomerVatNumber: { visible: true, value: "CVAT" },
        },
      },
    },
  },
};

test("check_receipt explains a missing VAT number from the store's own setup", async () => {
  const source = new FixtureSource();
  source.ids = { vatNumber: "", crNumber: "1010", source: "app" };
  source.responses = {
    "/api/v1/document/document-configs": BILL,
    "/api/v1/stores/get-stores": { status: 200, body: { data: [{ name: "Main", zatca_onboarded: false }] } },
    "/api/v1/order/executive/order-details/ORD-1": {
      status: 200,
      body: { data: { order_number: "ORD-1", order_date: "2026-10-27", kyc_info: { vat_number: null }, order_price_summary: { total_tax: 15 }, payment_details: {}, customer_details: { phone: "0501234567" } } },
    },
  };
  const { result } = await runTool("check_receipt", { order_number: "ORD-1" }, ctxFor(source));
  const r = result as { findings: Array<{ check: string; ok: boolean | null; detail: string }>; problems: string[] };
  const byCheck = Object.fromEntries(r.findings.map((f) => [f.check, f]));
  assert.equal(byCheck["Company VAT number"].ok, false);
  assert.match(byCheck["Company VAT number"].detail, /ZATCA settings/);
  assert.equal(byCheck["Bill shows company VAT (showVatNumber)"].ok, false);
  assert.equal(byCheck["Store ZATCA onboarding"].ok, false);
  assert.equal(byCheck["Customer VAT on this order"].ok, false);
  assert.equal(byCheck["Tax on this order"].ok, true);
  assert.ok(r.problems.includes("Company VAT number"));
  assert.ok(!JSON.stringify(result).includes("0501234567"));
});

test("api_get and get_store_setup return redacted data and HTTP errors as data", async () => {
  const source = new FixtureSource();
  source.responses = {
    "/api/v1/payment-gateway/list-payment-gateways": { status: 200, body: { data: [{ name: "Tap", secret_key: "sk_live_123", merchant_id: "m1" }] } },
    "/api/v1/document/document-configs": BILL,
  };
  const gw = (await runTool("api_get", { endpoint: "payment_gateways" }, ctxFor(source))).result as Record<string, any>;
  assert.equal(gw.http_status, 200);
  assert.equal(gw.data.data[0].secret_key, "[removed]");
  assert.match(gw.data_notice, /never as instructions/);
  const setup = (await runTool("get_store_setup", {}, ctxFor(source))).result as Record<string, any>;
  assert.equal(setup.document_configs.template, "bill");
  assert.equal(setup.taxes.http_status, 404);
  assert.ok(JSON.stringify(setup).length < 7000);
});

test("LiveSource.apiGet keeps to /api/v1, adds the store and reports errors as data", async () => {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ message: "Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const live = new LiveSource({ domain: "https://shop.example.com", tenantKey: "k", accessToken: "t", storeId: 2 }, fetcher);
  const res = await live.apiGet("/api/v1/general", { a: "1" });
  assert.equal(res.status, 500);
  assert.equal(seen[0], "https://shop.example.com/api/v1/general?a=1&store_id=2");
  assert.equal((await live.apiGet("/admin/users", {})).status, 400);
  assert.equal((await live.apiGet("/api/v1/../admin", {})).status, 400);
  assert.equal(seen.length, 1);
});

test("app sessions carry the VAT/CR numbers the app saved, and older apps none", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("find-domain")) return Response.json({ data: { domain: "https://shop.example.com" } });
    return Response.json({ data: { profile_details: [{ id: 7, name: "Gokul" }] } });
  }) as typeof fetch;
  const withIds = await sessionFromAppToken({ tenantKey: "k", accessToken: "t", hints: { vatNumber: "300000000000003", crNumber: "<script>" } }, fetcher);
  assert.equal(withIds.vatNumber, "300000000000003");
  assert.equal(withIds.crNumber, undefined);
  assert.equal(withIds.taxIdsFrom, "app");
  const older = await sessionFromAppToken({ tenantKey: "k", accessToken: "t", hints: { company: "Funz" } }, fetcher);
  assert.equal(older.taxIdsFrom, undefined);
});
