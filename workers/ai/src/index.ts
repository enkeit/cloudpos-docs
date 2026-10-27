// cloudpos-ai: AI analyst + docs assistant for CloudPOS on Workers AI.
//
//   GET  /                     web chat (static assets in ../public)
//   GET  /api/health           liveness + config summary
//   GET  /api/info             store info for the demo or a live session
//   POST /api/session/login    tenant key + email + password → sealed session
//   POST /api/session/store    switch the active store of a session
//   POST /api/chat             SSE stream of agent events
//   POST /api/admin/reindex    replace the docs vectors (Bearer ADMIN_TOKEN)

import { runAgent, type AgentEvent, type ChatTurn } from "./agent.ts";
import { embed, embeddingText, searchDocs, type DocChunk } from "./docs.ts";
import { openSession, sealSession } from "./session.ts";
import { DemoSource } from "./sources/demo.ts";
import { LiveApiError, LiveSource, signIn, type LiveSession } from "./sources/live.ts";
import type { DataSource } from "./sources/types.ts";

const SUGGESTIONS = {
  analysis: [
    "How did sales go last week compared to the week before?",
    "What are my top 5 products this month?",
    "Which items are low or out of stock?",
    "When are my busiest hours?",
    "Show revenue by category for the last 30 days",
    "Who are my best customers this month?",
  ],
  docs: ["How do I set up a receipt printer?", "How does kiosk mode work?", "كيف أضيف منتجًا جديدًا؟"],
};

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readJson<T>(request: Request, maxBytes = 64_000): Promise<T | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key })).success;
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function sourceFor(request: Request, env: Env): Promise<{ source: DataSource; session: LiveSession | null } | Response> {
  const token = bearer(request);
  if (!token) return { source: new DemoSource(), session: null };
  const session = await openSession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "Your session has expired. Please sign in again.", code: "session_expired" }, 401);
  return { source: new LiveSource(session), session };
}

/** Rough global ceiling on public demo usage so a bot can't run up the bill. */
async function demoBudgetLeft(env: Env): Promise<boolean> {
  const limit = Number(env.DEMO_DAILY_LIMIT ?? "0");
  if (!limit || !env.KV) return true;
  const key = `demo-count:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.KV.get(key)) ?? "0");
  if (used >= limit) return false;
  await env.KV.put(key, String(used + 1), { expirationTtl: 172_800 });
  return true;
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ message?: unknown; history?: unknown; model?: unknown }>(request);
  // Admins may try another model per request (for evaluation).
  const isAdmin = !!env.ADMIN_TOKEN && request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
  const model = isAdmin && typeof body?.model === "string" && body.model.startsWith("@cf/") ? body.model : env.CHAT_MODEL;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "Message is required." }, 400);
  const history: ChatTurn[] = Array.isArray(body?.history)
    ? (body!.history as Array<Record<string, unknown>>)
        .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content)
        .map((t) => ({ role: t.role as ChatTurn["role"], content: t.content as string }))
    : [];

  const resolved = await sourceFor(request, env);
  if (resolved instanceof Response) return resolved;
  const { source, session } = resolved;

  const limitKey = session ? `live:${session.domain}:${session.user ?? ""}` : `demo:${clientIp(request)}`;
  if (!isAdmin && !(await allowed(session ? env.LIVE_LIMITER : env.DEMO_LIMITER, limitKey))) {
    return json({ error: "Too many messages. Please wait a minute and try again." }, 429);
  }
  if (!session && !isAdmin && !(await demoBudgetLeft(env))) {
    return json({ error: "The public demo has reached today's limit. Please try again tomorrow." }, 429);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = async (event: AgentEvent | { type: "done" }) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const work = (async () => {
    try {
      await runAgent({
        ai: env.AI,
        model,
        fallbackModel: env.FALLBACK_MODEL || undefined,
        gatewayId: env.AI_GATEWAY_ID || undefined,
        ctx: { source, ai: env.AI, docsIndex: env.DOCS_INDEX, docsBaseUrl: env.DOCS_BASE_URL },
        history,
        message,
        emit,
      });
    } catch (error) {
      console.error("chat failed", error);
      const text =
        error instanceof LiveApiError
          ? error.message
          : "Sorry, the assistant ran into a problem. Please try again in a moment.";
      await emit({ type: "error", text });
    } finally {
      await emit({ type: "done" });
      await writer.close();
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(env.LOGIN_LIMITER, `login:${clientIp(request)}`))) {
    return json({ error: "Too many sign-in attempts. Please wait a minute." }, 429);
  }
  const body = await readJson<{ tenantKey?: string; email?: string; password?: string; storeId?: number }>(request, 4_000);
  if (!body?.tenantKey || !body.email || !body.password) return json({ error: "Company key, email and password are required." }, 400);
  try {
    const { session, stores } = await signIn({ tenantKey: body.tenantKey, email: body.email, password: body.password, storeId: body.storeId });
    const token = await sealSession(session, env.SESSION_SECRET);
    return json({ token, stores, info: await new LiveSource(session).info() });
  } catch (error) {
    const status = error instanceof LiveApiError && error.status >= 400 && error.status < 500 ? error.status : 502;
    return json({ error: error instanceof Error ? error.message : "Sign-in failed." }, status === 404 ? 400 : status);
  }
}

async function handleSwitchStore(request: Request, env: Env): Promise<Response> {
  const session = await openSession(bearer(request), env.SESSION_SECRET);
  if (!session) return json({ error: "Your session has expired. Please sign in again.", code: "session_expired" }, 401);
  const body = await readJson<{ storeId?: number }>(request, 1_000);
  const store = session.stores?.find((s) => s.id === Number(body?.storeId));
  if (!store) return json({ error: "Unknown store." }, 400);
  const next: LiveSession = { ...session, storeId: store.id, storeName: store.name };
  return json({ token: await sealSession(next, env.SESSION_SECRET), info: await new LiveSource(next).info() });
}

async function handleReindex(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || bearer(request) !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);
  if (!env.DOCS_INDEX) return json({ error: "DOCS_INDEX binding missing." }, 500);
  const body = await readJson<{ chunks?: DocChunk[] }>(request, 5_000_000);
  const chunks = (body?.chunks ?? []).filter((c) => c && c.id && c.url && c.text);
  if (!chunks.length) return json({ error: "No chunks." }, 400);

  const vectors = await embed(env.AI, chunks.map(embeddingText));
  let mutations = 0;
  for (let i = 0; i < chunks.length; i += 200) {
    await env.DOCS_INDEX.upsert(
      chunks.slice(i, i + 200).map((c, j) => ({
        id: c.id,
        values: vectors[i + j],
        metadata: { url: c.url, title: c.title, heading: c.heading, text: c.text },
      })),
    );
    mutations++;
  }
  // Delete vectors of chunks that no longer exist.
  const ids = chunks.map((c) => c.id);
  const previous: string[] = JSON.parse((await env.KV?.get("docs-manifest")) ?? "[]");
  const stale = previous.filter((id) => !ids.includes(id));
  if (stale.length) await env.DOCS_INDEX.deleteByIds(stale);
  await env.KV?.put("docs-manifest", JSON.stringify(ids));
  return json({ indexed: chunks.length, deleted: stale.length, batches: mutations });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let response: Response;
    try {
      if (url.pathname === "/api/health") {
        response = json({ ok: true, model: env.CHAT_MODEL, docs: !!env.DOCS_INDEX, gateway: env.AI_GATEWAY_ID || null });
      } else if (url.pathname === "/api/info" && request.method === "GET") {
        const resolved = await sourceFor(request, env);
        response = resolved instanceof Response ? resolved : json({ info: await resolved.source.info(), stores: resolved.session?.stores ?? [], suggestions: SUGGESTIONS });
      } else if (url.pathname === "/api/docs/search" && request.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
        if (!q || !env.DOCS_INDEX) response = json({ results: [] });
        else if (!(await allowed(env.DEMO_LIMITER, `docs:${clientIp(request)}`))) response = json({ error: "Too many requests." }, 429);
        else response = json({ results: (await searchDocs(env.AI, env.DOCS_INDEX, q, 5, 0)).map((h) => ({ ...h, link: `${env.DOCS_BASE_URL}${h.url}` })) });
      } else if (url.pathname === "/api/session/login" && request.method === "POST") {
        response = await handleLogin(request, env);
      } else if (url.pathname === "/api/session/store" && request.method === "POST") {
        response = await handleSwitchStore(request, env);
      } else if (url.pathname === "/api/chat" && request.method === "POST") {
        response = await handleChat(request, env, ctx);
      } else if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
        response = await handleReindex(request, env);
      } else if (url.pathname.startsWith("/api/")) {
        response = json({ error: "Not found" }, 404);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (error) {
      console.error("request failed", error);
      response = json({ error: "Internal error" }, 500);
    }
    if (!Object.keys(cors).length) return response;
    const withCors = new Response(response.body, response);
    for (const [k, v] of Object.entries(cors)) withCors.headers.set(k, v);
    return withCors;
  },
} satisfies ExportedHandler<Env>;
