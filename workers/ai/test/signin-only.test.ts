import assert from "node:assert/strict";
import { test } from "node:test";

import { signInRequired } from "../src/index.ts";
import { issuePass, passCookie, PASS_TTL_MS, verifyPass } from "../src/pass.ts";
import web from "../src/web.ts";
// The docs proxy verifies passes with its own copy of the code (plain JS, no types).
// @ts-ignore
import { verifyPass as proxyVerifyPass } from "../../../proxy/src/pass.js";

const SECRET = "pass-secret-0123456789abcdefghijklmnop";

test("passes verify until they expire, on both sites, and not with another key or edits", async () => {
  const now = Date.parse("2026-10-28T00:00:00Z");
  const pass = await issuePass(SECRET, now);
  assert.equal(await verifyPass(pass, SECRET, now + 1000), true);
  assert.equal(await proxyVerifyPass(pass, SECRET, now + 1000), true);
  assert.equal(await verifyPass(pass, SECRET, now + PASS_TTL_MS + 1), false);
  assert.equal(await proxyVerifyPass(pass, "other-secret", now), false);
  const [v, exp, nonce, sig] = pass.split(".");
  assert.equal(await proxyVerifyPass([v, String(Number(exp) + PASS_TTL_MS), nonce, sig].join("."), SECRET, now), false);
  assert.equal(await proxyVerifyPass("", SECRET, now), false);
  assert.match(passCookie(pass, "cloudposai.com"), /^cp_pass=v1\..+; Domain=cloudposai.com; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(passCookie("", "cloudposai.com"), /Max-Age=0/);
});

test("with REQUIRE_SIGN_IN, guests can't chat, search docs or read history; the app and sign-in still work", () => {
  const env = { REQUIRE_SIGN_IN: "true" };
  const guest = (path: string) => signInRequired(new Request(`https://ai.example.com${path}`), env, path);
  for (const path of ["/api/chat", "/api/conversations", "/api/conversations/abc", "/api/docs/search", "/api/guest/pass"]) assert.equal(guest(path), true, path);
  for (const path of ["/api/info", "/api/session/login", "/api/session/exchange", "/api/health"]) assert.equal(guest(path), false, path);
  const signedIn = new Request("https://ai.example.com/api/chat", { headers: { Authorization: "Bearer t" } });
  assert.equal(signInRequired(signedIn, env, "/api/chat"), false);
  assert.equal(signInRequired(new Request("https://ai.example.com/api/chat"), {}, "/api/chat"), false);
});

test("the web front end sets the pass on sign-in and for signed-in sessions, and clears it on sign-out", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const auth = input instanceof Request ? input.headers.get("Authorization") : null;
    if (url.pathname === "/api/session/login") return Response.json({ token: "s1", info: { mode: "live" } });
    if (url.pathname === "/api/info") return Response.json({ info: auth === "Bearer good" ? { mode: "live" } : null });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  try {
    const env = { ASSETS: {} as Fetcher, BACKEND_URL: "https://backend.example.com", PROXY_KEY: "k", DOCS_PASS_SECRET: SECRET, PASS_DOMAIN: "cloudposai.com" };
    const call = (path: string, headers: Record<string, string> = {}) =>
      web.fetch(new Request(`https://ai.cloudposai.com${path}`, { method: "POST", headers, body: "{}" }) as never, env as never) as Promise<Response>;

    const login = await call("/api/session/login");
    assert.equal(login.status, 200);
    const cookie = login.headers.get("Set-Cookie") ?? "";
    assert.ok(await verifyPass(cookie.match(/cp_pass=([^;]+)/)?.[1], SECRET));
    assert.equal(((await login.json()) as { token: string }).token, "s1");

    assert.match((await call("/api/session/pass", { Authorization: "Bearer good" })).headers.get("Set-Cookie") ?? "", /cp_pass=v1\./);
    const refused = await call("/api/session/pass", { Authorization: "Bearer bad" });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("Set-Cookie"), null);

    assert.match((await call("/api/session/logout")).headers.get("Set-Cookie") ?? "", /cp_pass=; .*Max-Age=0/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
