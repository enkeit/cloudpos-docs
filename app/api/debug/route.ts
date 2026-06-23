export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json({
    hasClientId: !!process.env.KEYSTATIC_GITHUB_CLIENT_ID,
    hasClientSecret: !!process.env.KEYSTATIC_GITHUB_CLIENT_SECRET,
    hasSecret: !!process.env.KEYSTATIC_SECRET,
    clientIdValue: process.env.KEYSTATIC_GITHUB_CLIENT_ID?.slice(0, 6) + "...",
    cookies: request.headers.get("cookie") ?? "NONE",
  });
}
