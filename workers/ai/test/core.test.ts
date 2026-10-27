import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanAnswer, readModelOutput, runAgent, type AgentEvent } from "../src/agent.ts";
import { chunkMdx, urlForDocPath } from "../src/docs.ts";
import { calendarContext, previousRange, resolvePeriod } from "../src/period.ts";
import { openSession, sealSession } from "../src/session.ts";
import { LiveSource, normalizeDomain, parseApiDate, signIn } from "../src/sources/live.ts";
import { DOCS_TOOL_SPECS, runTool, TOOL_SPECS, type ToolContext } from "../src/tools.ts";
import { FixtureSource } from "./fixture-source.ts";

const store = () => new FixtureSource();
const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuv";

test("periods resolve Monday-based weeks and months", () => {
  const today = "2026-10-27";
  assert.deepEqual(resolvePeriod("last_week", today), { from: "2026-10-19", to: "2026-10-25", label: "Last week" });
  assert.deepEqual(resolvePeriod("this_week", today), { from: "2026-10-26", to: "2026-10-27", label: "This week" });
  assert.deepEqual(resolvePeriod("last_month", today), { from: "2026-09-01", to: "2026-09-30", label: "Last month" });
  assert.equal(resolvePeriod("last_7_days", today).from, "2026-10-21");
  assert.equal(resolvePeriod("nonsense", today).label, "Last 30 days");
  assert.deepEqual(resolvePeriod("custom", today, { from: "2026-10-10", to: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-10", label: "2026-10-01 to 2026-10-10" });
  assert.deepEqual(previousRange(resolvePeriod("last_week", today)), { from: "2026-10-12", to: "2026-10-18", label: "Previous 7 days" });
  assert.match(calendarContext(today), /Tuesday 2026-10-27/);
});

test("sessions round-trip and reject tampering, wrong keys and expiry", async () => {
  const session = { domain: "https://shop.example.com", tenantKey: "key", accessToken: "tok", storeId: 3 };
  const token = await sealSession(session, SECRET, 1_000);
  assert.deepEqual(await openSession(token, SECRET, 2_000), session);
  assert.equal(await openSession(token, "another-secret-0123456789abcdefghijklmnop", 2_000), null);
  // Flip one ciphertext character to a different one (always a real change).
  const at = token.length - 5;
  const tampered = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
  assert.equal(await openSession(tampered, SECRET, 2_000), null);
  assert.equal(await openSession(token, SECRET, 1_000 + 13 * 3600 * 1000), null);
  assert.equal(await openSession("garbage", SECRET), null);
  await assert.rejects(sealSession(session, "short"));
});

test("mdx chunking", () => {
  assert.equal(urlForDocPath("pos-app/index.mdx"), "/docs/pos-app");
  assert.equal(urlForDocPath("pos-app\\billing.mdx"), "/docs/pos-app/billing");
  const chunks = chunkMdx(
    "pos-app/printing.mdx",
    `---\ntitle: Printing\ndescription: Set up receipt printers\n---\nimport { Callout } from 'x';\n\n# Printing\n\nIntro paragraph about printers in the store and how they work.\n\n## Bluetooth printers\n\n<Callout type="info">Pair the printer first in Android settings before opening the app.</Callout>\n\nSee [settings](/docs/x) for more.\n\n## Network printers\n\nEnter the printer IP address and port 9100 under Settings › Printers.\n`,
  );
  assert.deepEqual(chunks.map((c) => c.heading), ["Printing", "Bluetooth printers", "Network printers"]);
  assert.ok(chunks.every((c) => c.url === "/docs/pos-app/printing" && c.title === "Printing"));
  assert.ok(!chunks[1].text.includes("<Callout") && chunks[1].text.includes("Pair the printer") && chunks[1].text.includes("See settings"));
  assert.ok(!chunks[0].text.includes("import"));
});

test("live helpers parse API dates and reject unsafe domains", () => {
  assert.deepEqual(parseApiDate("2026-10-27 14:05:00"), { date: "2026-10-27", hour: 14 });
  assert.deepEqual(parseApiDate("27-10-2026 02:15 PM"), { date: "2026-10-27", hour: 14 });
  assert.deepEqual(parseApiDate("2026-10-27"), { date: "2026-10-27", hour: undefined });
  assert.equal(parseApiDate("yesterday"), null);
  assert.equal(normalizeDomain("tenant.cloudposai.com/"), "https://tenant.cloudposai.com");
  assert.throws(() => normalizeDomain("http://tenant.cloudposai.com"));
  assert.throws(() => normalizeDomain("localhost:8000"));
  assert.throws(() => normalizeDomain("10.0.0.5"));
});

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

test("live sign-in resolves the tenant domain and seals store info", async () => {
  const seen: string[] = [];
  const fetcher = fakeFetch(
    {
      "find-domain": { status: "success", data: { domain: "acme.cloudposai.com" } },
      "/api/v1/user/signin": { status: "success", data: { access_token: "abc", name: "Sara", company_name: "Acme", user_role: "admin", time_zone: "Asia/Dubai", stores: [{ store_id: 7, store_name: "Main" }, { id: 9, name: "Mall" }] } },
    },
    seen,
  );
  const { session, stores } = await signIn({ tenantKey: " KEY ", email: "a@b.c", password: "pw", storeId: 9 }, fetcher);
  assert.equal(session.domain, "https://acme.cloudposai.com");
  assert.equal(session.tenantKey, "KEY");
  assert.equal(session.storeId, 9);
  assert.equal(session.storeName, "Mall");
  assert.deepEqual(stores, [{ id: 7, name: "Main" }, { id: 9, name: "Mall" }]);
  assert.ok(seen[1].startsWith("POST https://acme.cloudposai.com/api/v1/user/signin"));
});

test("live source aggregates the sales report and sends tenant headers", async () => {
  let headers: Headers | undefined;
  const base = fakeFetch({
    "/api/v1/reports/sales-report": {
      status: "success",
      data: [
        { customer_name: "Ali", created_by: "x", date: "2026-10-20 09:10:00", total_price: 100 },
        { customer_name: "Ali", created_by: "x", date: "2026-10-21 18:00:00", total_price: "50.5" },
        { customer_name: "Walk-in Customer", created_by: "x", date: "2026-10-21 18:30:00", total_price: 20 },
        { customer_name: "Out of range", created_by: "x", date: "2026-09-01 10:00:00", total_price: 999 },
      ],
    },
    "/api/v1/product-sales-report": { status: "success", data: { currency: "AED", data: [{ product_name: "Tea", category: "Drinks", sales_count: 10, total_price: 80 }, { product_name: "Cake", category: "Food", sales_count: "3", total_price: "90" }], pagination: { last_page: 1 } } },
    "/api/v1/product/list-stocks": { status: "success", data: { current_page: 1, last_page: 1, data: [{ product_name: "Milk", qty: "2", reorder_level: 5 }, { product_name: "Rice", qty: 0 }, { product_name: "Salt", qty: 50, reorder_level: 5 }] } },
  });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return base(input, init);
  }) as typeof fetch;
  const live = new LiveSource({ domain: "https://acme.cloudposai.com", tenantKey: "KEY", accessToken: "tok", storeId: 7, timeZone: "Asia/Dubai" }, fetcher);
  const range = { from: "2026-10-19", to: "2026-10-25", label: "Last week" };
  const summary = await live.salesSummary(range);
  assert.equal(summary.revenue, 170.5);
  assert.equal(summary.orders, 3);
  assert.equal(headers?.get("Authorization"), "Bearer tok");
  assert.equal(headers?.get("X-Tenant"), "KEY");
  assert.deepEqual((await live.topCustomers(range, 5)).map((c) => [c.name, c.orders, c.revenue]), [["Ali", 2, 150.5]]);
  assert.deepEqual((await live.topProducts(range, 1, "revenue")).map((p) => p.name), ["Cake"]);
  assert.equal((await live.info()).currency, "AED");
  const stock = await live.stock("low", 10);
  assert.deepEqual(stock.rows.map((r) => [r.name, r.status]), [["Rice", "out"], ["Milk", "low"]]);
  const { hourly } = await live.timePatterns(range);
  assert.deepEqual(hourly.map((h) => h.hour), [9, 18]);
});

test("model output normalisation", () => {
  const openai = readModelOutput({ choices: [{ message: { content: null, tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] } }] });
  assert.equal(openai.toolCalls[0].function.name, "x");
  const legacy = readModelOutput({ response: "hi", tool_calls: [{ name: "y", arguments: { a: 1 } }] });
  assert.equal(legacy.content, "hi");
  assert.equal(legacy.toolCalls[0].function.arguments, '{"a":1}');
  assert.equal(cleanAnswer("<think>secret</think>\nAnswer"), "Answer");
});

test("every tool runs against a signed-in store", async () => {
  const ctx: ToolContext = { source: store(), ai: {} as Ai, docsBaseUrl: "https://docs" };
  for (const spec of TOOL_SPECS) {
    const out = await runTool(spec.function.name, { period: "last_30_days", filter: "low", query: "printer" }, ctx);
    assert.ok(out.result, spec.function.name);
  }
  const summary = (await runTool("get_sales_summary", { period: "last_week" }, ctx)).result as any;
  assert.equal(summary.current.range.from, "2026-10-19");
  assert.equal(summary.previous.range.from, "2026-10-12");
  assert.equal(typeof summary.change_pct.revenue, "number");
});

test("agent runs tools then answers, streaming visuals", async () => {
  const calls: any[] = [];
  const ai = {
    run: async (_model: string, input: any) => {
      calls.push(input);
      if (calls.length === 1) {
        return { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_top_products", arguments: '{"period":"this_month","limit":3}' } }] } }] };
      }
      return { choices: [{ message: { content: "Spanish Latte leads this month." } }] };
    },
  } as unknown as Ai;
  const events: AgentEvent[] = [];
  await runAgent({ ai, model: "m", ctx: { source: store(), ai, docsBaseUrl: "" }, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], message: "top products?", emit: (e) => void events.push(e) });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "c1"));
  assert.deepEqual(events.filter((e) => e.type !== "status").map((e) => e.type), ["tool", "visual", "answer"]);
  assert.equal((events.at(-1) as any).text, "Spanish Latte leads this month.");
});

test("agent falls back to the second model when the first one fails", async () => {
  const used: string[] = [];
  const ai = {
    run: async (model: string) => {
      used.push(model);
      if (model === "primary") throw new Error("capacity");
      return { choices: [{ message: { content: "ok" } }] };
    },
  } as unknown as Ai;
  const events: AgentEvent[] = [];
  await runAgent({ ai, model: "primary", fallbackModel: "backup", ctx: { source: store(), ai, docsBaseUrl: "" }, history: [], message: "hi", emit: (e) => void events.push(e) });
  assert.deepEqual(used, ["primary", "backup"]);
  assert.equal((events.at(-1) as any).text, "ok");
});

test("guests only get docs search; data tools require sign-in", async () => {
  assert.deepEqual(DOCS_TOOL_SPECS.map((t) => t.function.name), ["search_docs"]);
  const guest: ToolContext = { source: null, ai: {} as Ai, docsBaseUrl: "" };
  for (const spec of TOOL_SPECS.filter((t) => t.function.name !== "search_docs")) {
    const out = await runTool(spec.function.name, { period: "last_week" }, guest);
    assert.deepEqual((out.result as any).sign_in_required, true, spec.function.name);
    assert.equal(out.visuals, undefined);
  }
});

test("guest chat offers only docs search and a no-figures prompt", async () => {
  const calls: any[] = [];
  const ai = {
    run: async (_m: string, input: any) => {
      calls.push(input);
      return { choices: [{ message: { content: "Please sign in to see your sales." } }] };
    },
  } as unknown as Ai;
  await runAgent({ ai, model: "m", ctx: { source: null, ai, docsBaseUrl: "" }, history: [], message: "What were my sales?", emit: () => {} });
  assert.deepEqual(calls[0].tools.map((t: any) => t.function.name), ["search_docs"]);
  const system = calls[0].messages[0].content as string;
  assert.match(system, /not signed in/);
  assert.match(system, /Never state, estimate or make up/);
  assert.doesNotMatch(system, /Store: /);
});

test("frontend proxy forwards the visitor IP with the key and strips spoofable headers", async () => {
  const { backendRequest } = await import("../src/web.ts");
  const incoming = new Request("https://ai.cloudposai.com/api/chat?x=1", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.9", "X-Client-IP": "1.2.3.4", "X-Proxy-Key": "forged", "X-Admin-Token": "guess", Authorization: "Bearer s" },
    body: '{"message":"hi"}',
  });
  const out = backendRequest(incoming, { ASSETS: {} as Fetcher, BACKEND_URL: "https://backend.example.com", PROXY_KEY: "real" });
  assert.equal(out.url, "https://backend.example.com/api/chat?x=1");
  assert.equal(out.headers.get("X-Client-IP"), "203.0.113.9");
  assert.equal(out.headers.get("X-Proxy-Key"), "real");
  assert.equal(out.headers.get("X-Admin-Token"), null);
  assert.equal(out.headers.get("Authorization"), "Bearer s");
  assert.equal(await out.text(), '{"message":"hi"}');
});

test("backend trusts X-Client-IP only with the right proxy key", async () => {
  const { clientIp } = await import("../src/index.ts");
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: { "CF-Connecting-IP": "198.51.100.1", ...h } });
  assert.equal(clientIp(req({ "X-Client-IP": "203.0.113.9", "X-Proxy-Key": "k" }), { PROXY_KEY: "k" }), "203.0.113.9");
  assert.equal(clientIp(req({ "X-Client-IP": "203.0.113.9", "X-Proxy-Key": "wrong" }), { PROXY_KEY: "k" }), "198.51.100.1");
  assert.equal(clientIp(req({ "X-Client-IP": "203.0.113.9" }), { PROXY_KEY: "" }), "198.51.100.1");
});

test("history owners never mix guests, users or tenants", async () => {
  const { ownerFor, titleFrom } = await import("../src/history.ts");
  const visitor = "3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b";
  assert.equal(ownerFor(null, visitor), `guest:${visitor}`);
  assert.equal(ownerFor(null, "not-a-uuid"), null);
  assert.equal(ownerFor(null, null), null);
  assert.equal(ownerFor({ domain: "https://a.cloudposai.com", userId: 7 }, visitor), "live:https://a.cloudposai.com:7");
  assert.notEqual(ownerFor({ domain: "https://a.cloudposai.com", userId: 7 }, null), ownerFor({ domain: "https://b.cloudposai.com", userId: 7 }, null));
  assert.equal(titleFrom("  How do I\n set up a printer?  "), "How do I set up a printer?");
  assert.equal(titleFrom("x".repeat(200)).length, 80);
});

test("guest passes are bound to the visitor, expire, and can't be forged", async () => {
  const { issueGuestPass, verifyGuestPass } = await import("../src/guard.ts");
  const v = "3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b";
  const { pass } = await issueGuestPass(v, SECRET, 1_000);
  assert.equal(await verifyGuestPass(pass, v, SECRET, 2_000), true);
  assert.equal(await verifyGuestPass(pass, "11111111-1111-4111-8111-111111111111", SECRET, 2_000), false);
  assert.equal(await verifyGuestPass(pass, v, "another-secret-0123456789abcdefghijk", 2_000), false);
  assert.equal(await verifyGuestPass(pass, v, SECRET, 1_000 + 3 * 3600_000), false);
  const [ver, exp, sig] = pass.split(".");
  assert.equal(await verifyGuestPass(`${ver}.${Number(exp) + 999999}.${sig}`, v, SECRET, 2_000), false);
  assert.equal(await verifyGuestPass(null, v, SECRET), false);
});

test("page context is trimmed to short plain strings", async () => {
  const { pageContextFrom } = await import("../src/agent.ts");
  assert.equal(pageContextFrom(null), undefined);
  assert.equal(pageContextFrom({ screen: "  " }), undefined);
  assert.deepEqual(pageContextFrom({ screen: "Order details\n", details: "Order #1\u0000 total SAR 200" }), { screen: "Order details", details: "Order #1 total SAR 200" });
  assert.equal(pageContextFrom({ screen: "x".repeat(500) })!.screen.length, 120);
  assert.equal(pageContextFrom({ screen: "s", details: "d".repeat(5000) })!.details!.length, 800);
  assert.deepEqual(pageContextFrom({ screen: "s", details: 42 }), { screen: "s" });
});

test("app token exchange takes the user id from the tenant API, not the app", async () => {
  const { sessionFromAppToken } = await import("../src/sources/live.ts");
  const fetcher = fakeFetch({
    "find-domain": { status: "success", data: { domain: "acme.cloudposai.com" } },
    "/api/v1/dashboard": { status: "success", data: { profile_details: [{ id: 42, name: "Sara" }] } },
  });
  const s = await sessionFromAppToken({ tenantKey: "K", accessToken: "tok", storeId: 9, hints: { company: "Acme\u0007", stores: [{ id: 9, name: "Mall" }] } }, fetcher);
  assert.equal(s.userId, 42);
  assert.equal(s.user, "Sara");
  assert.equal(s.storeName, "Mall");
  assert.equal(s.company, "Acme");
  const denied = fakeFetch({ "find-domain": { data: { domain: "acme.cloudposai.com" } }, "/api/v1/dashboard": { status: "failed", data: {} } });
  await assert.rejects(sessionFromAppToken({ tenantKey: "K", accessToken: "bad" }, denied), /could not be verified/);
});
