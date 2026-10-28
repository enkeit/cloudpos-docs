// cloudpos-ai: AI analyst + docs assistant for CloudPOS on Workers AI.
//
//   GET  /                     web chat (static assets in ../public)
//   GET  /api/health           liveness + config summary
//   GET  /api/info             signed-in store info (null for guests) + suggestions
//   POST /api/session/login    tenant key + email + password → sealed session
//   POST /api/session/store    switch the active store of a session
//   POST /api/session/exchange the POS app's login (tenant key + token) → session
//   POST /api/guest/pass       Turnstile token → 2-hour guest pass
//   POST /api/uploads          one image or PDF (multipart "file") → attachment ref (signed-in only)
//   GET  /api/uploads/:id      an attachment's file, for its owner
//   POST /api/chat             SSE stream of agent events (saved to history)
//   GET  /api/conversations    the caller's recent chats
//   GET  /api/conversations/:id    one chat's messages
//   DELETE /api/conversations/:id  delete one chat
//   POST /api/admin/reindex    replace the docs vectors (Bearer ADMIN_TOKEN)
//
// History owner: signed-in users by session; guests by the X-Visitor-Id
// header (a random id their browser keeps).

import { pageContextFrom, runAgent, type AgentEvent, type ChatTurn } from "./agent.ts";
import { embed, embeddingText, searchDocs, type DocChunk } from "./docs.ts";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
  listConversations,
  ownerFor,
  purgeOld,
  recentTurns,
  type ConversationRow,
} from "./history.ts";
import { openSession, sealSession } from "./session.ts";
import type { Visual } from "./tools.ts";
import { DAILY_LIMITS, issueGuestPass, verifyGuestPass, verifyTurnstile, withinDaily } from "./guard.ts";
import { LiveApiError, LiveSource, sessionFromAppToken, signIn, type LiveSession } from "./sources/live.ts";
import type { DataSource } from "./sources/types.ts";
import { isAttachmentId, loadAttachments, purgeUploads, readUpload, saveUpload, UPLOAD_LIMITS, UploadError, type AttachmentRef } from "./uploads.ts";
import type { Attachments } from "./agent.ts";

const SUGGESTIONS = {
  analysis: [
    "How did sales go last week compared to the week before?",
    "What are my top 5 products this month?",
    "Which items are low or out of stock?",
    "When are my busiest hours?",
    "Show revenue by category for the last 30 days",
    "Who are my best customers this month?",
  ],
  docs: [
    "How do I set up a receipt printer?",
    "How does kiosk mode work?",
    "How do I add a new product?",
    "How do I set up loyalty points for customers?",
    "How do I print a daily sales report?",
    "كيف أضيف منتجًا جديدًا؟",
  ],
};

/** Guests see only how-to suggestions; analysis needs a signed-in store. */
function suggestionsFor(signedIn: boolean) {
  return signedIn ? SUGGESTIONS : { analysis: [], docs: SUGGESTIONS.docs };
}

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

/**
 * The visitor's IP. Behind the ai.cloudposai.com frontend (another account)
 * every request comes from that Worker, so its forwarded X-Client-IP is
 * trusted, but only when it also proves itself with the shared PROXY_KEY.
 */
export function clientIp(request: Request, env: Pick<Env, "PROXY_KEY">): string {
  const forwarded = request.headers.get("X-Client-IP");
  if (forwarded && env.PROXY_KEY && request.headers.get("X-Proxy-Key") === env.PROXY_KEY) return forwarded;
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

/** Routes a guest could otherwise use; closed to them when REQUIRE_SIGN_IN is "true". */
const GUEST_ROUTES = /^\/api\/(chat|conversations(\/.*)?|docs\/search|guest\/pass)$/;

export function signInRequired(request: Request, env: { REQUIRE_SIGN_IN?: string }, path: string): boolean {
  return env.REQUIRE_SIGN_IN === "true" && GUEST_ROUTES.test(path) && !bearer(request);
}

/** Guests (no token) get no data source at all: docs support only. */
async function sourceFor(request: Request, env: Env): Promise<{ source: DataSource | null; session: LiveSession | null } | Response> {
  const token = bearer(request);
  if (!token) return { source: null, session: null };
  const session = await openSession(token, env.SESSION_SECRET);
  if (!session) return json({ error: "Your session has expired. Please sign in again.", code: "session_expired" }, 401);
  return { source: new LiveSource(session), session };
}

/** Rough global ceiling on public guest usage so a bot can't run up the bill. */
async function guestBudgetLeft(env: Env): Promise<boolean> {
  const limit = Number(env.GUEST_DAILY_LIMIT ?? "0");
  if (!limit || !env.KV) return true;
  const key = `guest-count:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.KV.get(key)) ?? "0");
  if (used >= limit) return false;
  await env.KV.put(key, String(used + 1), { expirationTtl: 172_800 });
  return true;
}

/**
 * Per-minute rate limits, the guest human check and daily fair-use caps.
 * Returns the refusal, or null when the message may go ahead.
 */
async function chatGuard(request: Request, env: Env, session: LiveSession | null): Promise<Response | null> {
  const ip = clientIp(request, env);
  if (session) {
    const user = `${session.domain}:${session.userId ?? session.user ?? ""}`;
    if (!(await allowed(env.LIVE_LIMITER, `live:${user}`))) return json({ error: "Too many messages. Please wait a minute and try again." }, 429);
    if (!(await withinDaily(env.KV, `user:${user}`, DAILY_LIMITS.userPerDay))) {
      return json({ error: "You've reached today's AI assistant limit. It resets at midnight UTC." }, 429);
    }
    return null;
  }
  if (!(await allowed(env.GUEST_LIMITER, `guest:${ip}`))) return json({ error: "Too many messages. Please wait a minute and try again." }, 429);
  const visitorId = request.headers.get("X-Visitor-Id");
  if (env.TURNSTILE_SECRET && !(await verifyGuestPass(request.headers.get("X-Guest-Pass"), visitorId, env.SESSION_SECRET))) {
    return json({ error: "Please confirm you're human to continue.", code: "guest_pass_required" }, 401);
  }
  const fairUse = "You've reached today's free help limit. Please try again tomorrow, or sign in to CloudPOS.";
  if (!(await withinDaily(env.KV, `guest-ip:${ip}`, DAILY_LIMITS.guestPerIp))) return json({ error: fairUse }, 429);
  if (visitorId && !(await withinDaily(env.KV, `guest-visitor:${visitorId}`, DAILY_LIMITS.guestPerVisitor))) return json({ error: fairUse }, 429);
  if (!(await guestBudgetLeft(env))) return json({ error: "The help assistant is very busy today. Please try again tomorrow or sign in." }, 429);
  return null;
}

async function handleGuestPass(request: Request, env: Env): Promise<Response> {
  const visitorId = request.headers.get("X-Visitor-Id");
  if (!ownerFor(null, visitorId)) return json({ error: "Missing visitor id." }, 400);
  if (!env.TURNSTILE_SECRET) return json({ pass: null, expiresAt: null });
  if (!(await allowed(env.GUEST_LIMITER, `pass:${clientIp(request, env)}`))) return json({ error: "Too many requests." }, 429);
  const body = await readJson<{ token?: string }>(request, 4_000);
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, body?.token ?? "", clientIp(request, env)))) {
    return json({ error: "Human check failed. Please reload the page and try again." }, 403);
  }
  return json(await issueGuestPass(visitorId!, env.SESSION_SECRET));
}

/** The POS app trades its existing login for an AI session (no second sign-in). */
async function handleExchange(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(env.LIVE_LIMITER, `exchange:${clientIp(request, env)}`))) return json({ error: "Too many requests." }, 429);
  const body = await readJson<{ tenantKey?: string; accessToken?: string; storeId?: number; hints?: Record<string, unknown> }>(request, 16_000);
  if (!body?.tenantKey || !body.accessToken) return json({ error: "Company key and access token are required." }, 400);
  try {
    const session = await sessionFromAppToken({
      tenantKey: body.tenantKey,
      accessToken: body.accessToken,
      storeId: Number(body.storeId) || undefined,
      hints: body.hints as Parameters<typeof sessionFromAppToken>[0]["hints"],
    });
    return json({ token: await sealSession(session, env.SESSION_SECRET), info: await new LiveSource(session).info() });
  } catch (error) {
    const status = error instanceof LiveApiError && error.status >= 400 && error.status < 500 ? error.status : 502;
    return json({ error: error instanceof Error ? error.message : "Could not verify your login." }, status === 404 ? 400 : status);
  }
}

/** Signed-in users only: guests' docs help stays text-only to protect AI costs. */
async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!env.UPLOADS || !env.DB) return json({ error: "Attachments are not available." }, 503);
  const resolved = await sourceFor(request, env);
  if (resolved instanceof Response) return resolved;
  const owner = resolved.session ? ownerFor(resolved.session, null) : null;
  if (!owner) return json({ error: "Please sign in to attach files.", code: "sign_in_required" }, 401);
  if (!(await allowed(env.LIVE_LIMITER, `upload:${owner}`))) return json({ error: "Too many uploads. Please wait a minute and try again." }, 429);
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > UPLOAD_LIMITS.pdfBytes + 100_000) return json({ error: "That file is too large. The limit is 10 MB." }, 413);
  let file: File | string | null = null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return json({ error: "Please attach one file." }, 400);
  }
  if (!(file instanceof File)) return json({ error: "Please attach one file." }, 400);
  if (!(await withinDaily(env.KV, `uploads:${owner}`, UPLOAD_LIMITS.perDay))) {
    return json({ error: `You've reached today's limit of ${UPLOAD_LIMITS.perDay} attachments. It resets at midnight UTC.` }, 429);
  }
  try {
    return json({ attachment: await saveUpload(env, owner, file) });
  } catch (error) {
    if (error instanceof UploadError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function handleUploadRead(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.UPLOADS || !env.DB) return json({ error: "Not found" }, 404);
  const resolved = await sourceFor(request, env);
  if (resolved instanceof Response) return resolved;
  const owner = resolved.session ? ownerFor(resolved.session, null) : null;
  const file = owner ? await readUpload(env, owner, id) : null;
  if (!file) return json({ error: "Not found" }, 404);
  return new Response(file.body, {
    headers: {
      "Content-Type": file.mime,
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${file.name.replace(/[^\w.\- ]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ message?: unknown; history?: unknown; model?: unknown; conversationId?: unknown; context?: unknown; attachments?: unknown }>(request);
  // Admins may try another model per request (for evaluation).
  const isAdmin = !!env.ADMIN_TOKEN && request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
  const model = isAdmin && typeof body?.model === "string" && body.model.startsWith("@cf/") ? body.model : env.CHAT_MODEL;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const attachmentIds = Array.isArray(body?.attachments) ? body!.attachments.filter(isAttachmentId).slice(0, 8) : [];
  if (!message && !attachmentIds.length) return json({ error: "Message is required." }, 400);
  let history: ChatTurn[] = Array.isArray(body?.history)
    ? (body!.history as Array<Record<string, unknown>>)
        .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content)
        .map((t) => ({ role: t.role as ChatTurn["role"], content: t.content as string }))
    : [];

  const resolved = await sourceFor(request, env);
  if (resolved instanceof Response) return resolved;
  const { source, session } = resolved;

  if (message.length > 4000) return json({ error: "That message is too long. Please keep it under 4,000 characters." }, 413);
  if (attachmentIds.length && !session) return json({ error: "Please sign in to attach files.", code: "sign_in_required" }, 401);
  if (!isAdmin) {
    const blocked = await chatGuard(request, env, session);
    if (blocked) return blocked;
  }

  // History: with D1 and a known owner, the conversation's stored turns are
  // the model's context (the client's copy is only a fallback).
  const owner = env.DB ? ownerFor(session, request.headers.get("X-Visitor-Id")) : null;
  let refs: AttachmentRef[] = [];
  let files: Attachments | undefined;
  if (attachmentIds.length) {
    if (!owner || !env.UPLOADS) return json({ error: "Attachments are not available." }, 503);
    try {
      ({ refs, files } = await loadAttachments(env, owner, attachmentIds));
    } catch (error) {
      if (error instanceof UploadError) return json({ error: error.message }, error.status);
      throw error;
    }
  }
  let conversation: ConversationRow | null = null;
  if (owner) {
    const requested = typeof body?.conversationId === "string" ? body.conversationId : "";
    conversation = requested ? await getConversation(env.DB, owner, requested) : null;
    if (conversation) history = await recentTurns(env.DB, conversation.id);
    else conversation = await createConversation(env.DB, owner, message || refs.map((r) => r.name).join(", "));
    await addMessage(env.DB, conversation.id, "user", message, [], refs);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const visuals: Visual[] = [];
  let answer = "";
  const emit = async (event: AgentEvent | { type: "done" } | { type: "conversation"; id: string; title: string }) => {
    if (event.type === "visual") visuals.push(event.visual);
    if (event.type === "answer") answer = event.text;
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const work = (async () => {
    try {
      if (conversation) await emit({ type: "conversation", id: conversation.id, title: conversation.title });
      await runAgent({
        ai: env.AI,
        model,
        fallbackModel: env.FALLBACK_MODEL || undefined,
        gatewayId: env.AI_GATEWAY_ID || undefined,
        ctx: { source, ai: env.AI, docsIndex: env.DOCS_INDEX, docsBaseUrl: env.DOCS_BASE_URL },
        history,
        page: pageContextFrom(body?.context),
        message: message || "Please look at the attached file(s).",
        attachments: files,
        visionModel: env.VISION_MODEL || undefined,
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
      if (conversation && answer) {
        await addMessage(env.DB, conversation.id, "assistant", answer, visuals).catch((e) => console.error("history save failed", e));
      }
      await emit({ type: "done" });
      await writer.close();
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

async function handleConversations(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.DB) return json({ conversations: [] });
  const resolved = await sourceFor(request, env);
  if (resolved instanceof Response) return resolved;
  const owner = ownerFor(resolved.session, request.headers.get("X-Visitor-Id"));
  if (!owner) return json({ conversations: [] });
  const id = url.pathname.slice("/api/conversations/".length);
  if (url.pathname === "/api/conversations" && request.method === "GET") {
    return json({ conversations: await listConversations(env.DB, owner) });
  }
  if (id && request.method === "GET") {
    const messages = await getMessages(env.DB, owner, id);
    return messages ? json({ messages }) : json({ error: "Not found" }, 404);
  }
  if (id && request.method === "DELETE") {
    return (await deleteConversation(env.DB, owner, id)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }
  return json({ error: "Not found" }, 404);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(env.LOGIN_LIMITER, `login:${clientIp(request, env)}`))) {
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
        metadata: { url: c.url, title: c.title, heading: c.heading, text: c.text, ...(c.images?.length ? { images: JSON.stringify(c.images) } : {}) },
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
      if (signInRequired(request, env, url.pathname)) {
        response = json({ error: "Please sign in with your CloudPOS account to use the assistant.", code: "sign_in_required" }, 401);
      } else if (url.pathname === "/api/health") {
        response = json({ ok: true, model: env.CHAT_MODEL, visionModel: env.VISION_MODEL || null, uploads: !!env.UPLOADS, docs: !!env.DOCS_INDEX, gateway: env.AI_GATEWAY_ID || null });
      } else if (url.pathname === "/api/info" && request.method === "GET") {
        const resolved = await sourceFor(request, env);
        response =
          resolved instanceof Response
            ? resolved
            : json({ info: resolved.source ? await resolved.source.info() : null, stores: resolved.session?.stores ?? [], suggestions: suggestionsFor(!!resolved.source), turnstileSiteKey: resolved.source ? null : env.TURNSTILE_SITE_KEY || null });
      } else if (url.pathname === "/api/docs/search" && request.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
        if (!q || !env.DOCS_INDEX) response = json({ results: [] });
        else if (!(await allowed(env.GUEST_LIMITER, `docs:${clientIp(request, env)}`))) response = json({ error: "Too many requests." }, 429);
        else response = json({ results: (await searchDocs(env.AI, env.DOCS_INDEX, q, 5, 0)).map((h) => ({ ...h, link: `${env.DOCS_BASE_URL}${h.url}` })) });
      } else if (url.pathname === "/api/conversations" || url.pathname.startsWith("/api/conversations/")) {
        response = await handleConversations(request, env, url);
      } else if (url.pathname === "/api/guest/pass" && request.method === "POST") {
        response = await handleGuestPass(request, env);
      } else if (url.pathname === "/api/session/exchange" && request.method === "POST") {
        response = await handleExchange(request, env);
      } else if (url.pathname === "/api/session/login" && request.method === "POST") {
        response = await handleLogin(request, env);
      } else if (url.pathname === "/api/session/store" && request.method === "POST") {
        response = await handleSwitchStore(request, env);
      } else if (url.pathname === "/api/uploads" && request.method === "POST") {
        response = await handleUpload(request, env);
      } else if (url.pathname.startsWith("/api/uploads/") && request.method === "GET") {
        response = await handleUploadRead(request, env, url.pathname.slice("/api/uploads/".length));
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

  async scheduled(_event, env): Promise<void> {
    if (env.DB) console.log(`history purge removed ${await purgeOld(env.DB)} conversations`);
    if (env.DB && env.UPLOADS) console.log(`upload purge removed ${await purgeUploads(env)} attachments`);
  },
} satisfies ExportedHandler<Env>;
