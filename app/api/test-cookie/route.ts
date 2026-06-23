export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const cookies = request.headers.get("cookie") ?? "NONE";

  if (action === "set") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/api/test-cookie?action=read",
        "Set-Cookie": `test-cookie=hello123; Path=/; SameSite=Lax; Secure`,
      },
    });
  }

  return Response.json({ cookies, hasCookie: cookies.includes("test-cookie") });
}
