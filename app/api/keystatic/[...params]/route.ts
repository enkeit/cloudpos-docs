export const dynamic = "force-dynamic";

// Patch fetch to log GitHub token exchange
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('github.com/login/oauth/access_token')) {
    console.log("GitHub token exchange URL:", url.replace(/client_secret=[^&]+/, 'client_secret=REDACTED'));
    const res = await originalFetch(input, init);
    const clone = res.clone();
    const body = await clone.text();
    console.log("GitHub token response status:", res.status);
    console.log("GitHub token response body:", body);
    return res;
  }
  return originalFetch(input, init);
};

async function getHandler() {
  const { makeRouteHandler } = await import("@keystatic/next/route-handler");
  const { default: keystaticConfig } = await import("@/keystatic.config");
  return makeRouteHandler({ config: keystaticConfig });
}

export async function GET(request: Request) {
  try {
    const handler = await getHandler();
    return handler.GET(request);
  } catch (e) {
    console.error("Keystatic GET error:", e);
    throw e;
  }
}

export async function POST(request: Request) {
  try {
    const handler = await getHandler();
    return handler.POST(request);
  } catch (e) {
    console.error("Keystatic POST error:", e);
    throw e;
  }
}
