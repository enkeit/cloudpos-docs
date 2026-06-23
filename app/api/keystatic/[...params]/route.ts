export const dynamic = "force-dynamic";

async function getHandler() {
  const { makeRouteHandler } = await import("@keystatic/next/route-handler");
  const { default: keystaticConfig } = await import("@/keystatic.config");
  return makeRouteHandler({ config: keystaticConfig });
}

export async function GET(request: Request) {
  try {
    const handler = await getHandler();
    const response = await handler.GET(request);
    if (request.url.includes("oauth/callback")) {
      console.log("OAuth callback status:", response.status);
      console.log("OAuth callback headers:", JSON.stringify(Object.fromEntries(response.headers)));
      const body = await response.clone().text();
      console.log("OAuth callback body:", body);
    }
    return response;
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
