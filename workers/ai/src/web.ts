// ai.cloudposai.com frontend (IT Consult account, where cloudposai.com lives).
// Serves the chat UI from ../public and forwards /api/* to the backend Worker
// on the Enke dev account, which holds the AI, Vectorize and paid-plan models.
// It also hands out the sign-in pass cookie (pass.ts) that lets a signed-in
// CloudPOS user read docs.cloudposai.com. Deployed with wrangler.web.jsonc.

import { issuePass, passCookie } from "./pass.ts";

interface WebEnv {
  ASSETS: Fetcher;
  /** Backend origin, e.g. https://cloudpos-ai.enkedevelopment-427.workers.dev */
  BACKEND_URL: string;
  /** Shared with the backend so it trusts our X-Client-IP header. */
  PROXY_KEY: string;
  /** Signs the docs pass; shared with cloudpos-docs-proxy. */
  DOCS_PASS_SECRET?: string;
  /** Cookie domain for the pass, e.g. cloudposai.com. */
  PASS_DOMAIN?: string;
}

/** Headers a visitor must never be able to set on the backend request. */
const STRIPPED = ["x-client-ip", "x-proxy-key", "x-admin-token", "host"];

export function backendRequest(request: Request, env: WebEnv): Request {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.BACKEND_URL);
  const headers = new Headers(request.headers);
  for (const name of STRIPPED) headers.delete(name);
  headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") ?? "");
  headers.set("X-Proxy-Key", env.PROXY_KEY);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // `duplex` is required by the fetch spec for streamed bodies (Node enforces it).
  const init = { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: "manual", duplex: "half" };
  return new Request(target, init as RequestInit);
}

async function withPass(response: Response, env: WebEnv): Promise<Response> {
  if (!env.DOCS_PASS_SECRET) return response;
  const out = new Response(response.body, response);
  out.headers.append("Set-Cookie", passCookie(await issuePass(env.DOCS_PASS_SECRET), env.PASS_DOMAIN || "cloudposai.com"));
  return out;
}

/**
 * Pass routes, answered here: a successful sign-in or store switch also gets
 * the pass; /api/session/pass gives one to a browser that is already signed in
 * (its session is checked with the backend); /api/session/logout clears it.
 */
async function passRoute(request: Request, env: WebEnv, path: string): Promise<Response | null> {
  if (request.method !== "POST") return null;
  if (path === "/api/session/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": passCookie("", env.PASS_DOMAIN || "cloudposai.com") },
    });
  }
  if (path === "/api/session/pass") {
    const check = new Request(new URL("/api/info", request.url), { headers: request.headers });
    const res = await fetch(backendRequest(check, env));
    const body = (await res.json().catch(() => null)) as { info?: unknown } | null;
    if (!res.ok || !body?.info) return Response.json({ error: "Please sign in." }, { status: 401 });
    return withPass(Response.json({ ok: true }), env);
  }
  if (path === "/api/session/login" || path === "/api/session/store") {
    const res = await fetch(backendRequest(request, env));
    return res.ok ? withPass(res, env) : res;
  }
  return null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      // The body streams through untouched, so SSE chat answers arrive live.
      return (await passRoute(request, env, url.pathname)) ?? (await fetch(backendRequest(request, env)));
    } catch (error) {
      console.error("backend unreachable", error);
      return Response.json({ error: "The assistant is temporarily unavailable. Please try again shortly." }, { status: 502 });
    }
  },
} satisfies ExportedHandler<WebEnv>;
