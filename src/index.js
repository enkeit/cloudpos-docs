// docs.cloudposai.com → the EmDash docs worker. Public pages, search and media are
// served here; editing stays on the worker's own address because admin passkeys
// are bound to that origin.

const ADMIN_PATHS = [/^\/_emdash\/admin/, /^\/_emdash\/api\/auth/, /^\/_emdash\/api\/setup/, /^\/keystatic/];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const origin = new URL(env.ORIGIN);

		if (ADMIN_PATHS.some((p) => p.test(url.pathname))) {
			const target = url.pathname.startsWith("/keystatic") ? `${origin.origin}/_emdash/admin` : `${origin.origin}${url.pathname}${url.search}`;
			return Response.redirect(target, 302);
		}

		const upstream = new URL(url.pathname + url.search, origin);
		const headers = new Headers(request.headers);
		headers.set("X-Forwarded-Host", url.host);
		const response = await fetch(upstream, {
			method: request.method,
			headers,
			body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
			redirect: "manual",
		});

		const out = new Response(response.body, response);
		const location = out.headers.get("Location");
		if (location?.startsWith(origin.origin)) out.headers.set("Location", url.origin + location.slice(origin.origin.length));

		// Absolute links in pages (canonical, og:url, sitemap) should name this domain.
		const type = out.headers.get("Content-Type") ?? "";
		if (/text\/html|application\/xml|text\/xml/.test(type)) {
			const text = (await out.text()).replaceAll(origin.origin, url.origin);
			const headersOut = new Headers(out.headers);
			headersOut.delete("Content-Length");
			return new Response(text, { status: out.status, statusText: out.statusText, headers: headersOut });
		}
		return out;
	},
};
