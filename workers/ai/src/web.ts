// ai.cloudposai.com frontend (IT Consult account, where cloudposai.com lives).
// Serves the chat UI from ../public and forwards /api/* to the backend Worker
// on the Enke dev account, which holds the AI, Vectorize and paid-plan models.
// Deployed with wrangler.web.jsonc.

interface WebEnv {
  ASSETS: Fetcher;
  /** Backend origin, e.g. https://cloudpos-ai.enkedevelopment-427.workers.dev */
  BACKEND_URL: string;
  /** Shared with the backend so it trusts our X-Client-IP header. */
  PROXY_KEY: string;
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      // The body streams through untouched, so SSE chat answers arrive live.
      return await fetch(backendRequest(request, env));
    } catch (error) {
      console.error("backend unreachable", error);
      return Response.json({ error: "The assistant is temporarily unavailable. Please try again shortly." }, { status: 502 });
    }
  },
} satisfies ExportedHandler<WebEnv>;
