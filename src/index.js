// docs.cloudposai.com → the EmDash docs worker. Public pages, search and media are
// served here; editing stays on the worker's own address because admin passkeys
// are bound to that origin.
//
// The docs worker renders every page from D1 (about 2–4 s per page), so pages
// are kept in the edge cache: a visitor always gets the cached copy at once,
// and a copy older than FRESH_SECONDS is refreshed in the background, so edits
// show up within about a minute. Media files are content-addressed and kept a year.

const ADMIN_PATHS = [/^\/_emdash\/admin/, /^\/_emdash\/api\/auth/, /^\/_emdash\/api\/setup/, /^\/keystatic/];
/** Content-addressed files: uploaded media and hashed build assets. */
const MEDIA_PATH = /^\/(_emdash\/api\/media\/file|_astro)\//;
const FRESH_SECONDS = 60;
const KEEP_SECONDS = 7 * 24 * 60 * 60;
const MEDIA_SECONDS = 365 * 24 * 60 * 60;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const origin = new URL(env.ORIGIN);

		if (ADMIN_PATHS.some((p) => p.test(url.pathname))) {
			const target = url.pathname.startsWith("/keystatic") ? `${origin.origin}/_emdash/admin` : `${origin.origin}${url.pathname}${url.search}`;
			return Response.redirect(target, 302);
		}

		const isMedia = MEDIA_PATH.test(url.pathname);
		const cacheable = request.method === "GET" && (isMedia || !url.pathname.startsWith("/_emdash/"));
		if (!cacheable) return forward(request, url, origin);

		const cache = caches.default;
		const key = new Request(`${url.origin}${url.pathname}${url.search}`, { method: "GET" });
		const cached = await cache.match(key);
		if (cached) {
			const age = (Date.now() - Number(cached.headers.get("X-Cached-At") ?? 0)) / 1000;
			if (!isMedia && age > FRESH_SECONDS) ctx.waitUntil(refresh(request, url, origin, cache, key, isMedia));
			return withCacheStatus(cached, age > FRESH_SECONDS && !isMedia ? "STALE" : "HIT");
		}
		const response = await refresh(request, url, origin, cache, key, isMedia);
		return withCacheStatus(response, "MISS");
	},
};

/** Fetches from the docs worker and stores a successful copy in the edge cache. */
async function refresh(request, url, origin, cache, key, isMedia) {
	const response = await forward(request, url, origin);
	if (response.status !== 200) return response;
	const headers = new Headers(response.headers);
	headers.set("X-Cached-At", String(Date.now()));
	headers.delete("Set-Cookie");
	// Browsers revalidate pages each visit (the edge answers instantly); media never changes.
	headers.set("Cache-Control", isMedia ? `public, max-age=${MEDIA_SECONDS}, immutable` : "public, max-age=0, must-revalidate");
	const body = await response.arrayBuffer();
	const stored = new Response(body, { status: 200, headers: new Headers(headers) });
	stored.headers.set("Cache-Control", `public, s-maxage=${isMedia ? MEDIA_SECONDS : KEEP_SECONDS}`);
	await cache.put(key, stored);
	return new Response(body, { status: 200, headers });
}

/** Proxies the request to the docs worker, rewriting its own address to this domain. */
async function forward(request, url, origin) {
	const headers = new Headers(request.headers);
	headers.set("X-Forwarded-Host", url.host);
	const response = await fetch(new URL(url.pathname + url.search, origin), {
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
}

function withCacheStatus(response, status) {
	const out = new Response(response.body, response);
	out.headers.set("X-Docs-Cache", status);
	out.headers.delete("X-Cached-At");
	return out;
}
