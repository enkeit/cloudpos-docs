export const dynamic = "force-dynamic";

async function getHandler() {
  const { makeRouteHandler } = await import("@keystatic/next/route-handler");
  const { default: keystaticConfig } = await import("@/keystatic.config");
  return makeRouteHandler({ config: keystaticConfig });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  console.log("Keystatic GET:", url.pathname);
  console.log("Cookies in request:", request.headers.get("cookie") ?? "NONE");

  try {
    const handler = await getHandler();
    const response = await handler.GET(request);
    console.log("Response status:", response.status);
    console.log("Set-Cookie:", response.headers.get("set-cookie") ?? "NONE");
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
