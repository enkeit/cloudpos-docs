import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

interface GateEnv {
	/** Shared with the docs.cloudposai.com proxy, which only signed-in CloudPOS users get past. */
	DOCS_GATE_KEY?: string;
}

/**
 * The docs are for signed-in CloudPOS users only, so the public pages and
 * search answer only the docs.cloudposai.com proxy. Everything else under
 * /_emdash (the admin, its APIs, which check their own login, and the media
 * files the POS app shows) and the build assets stay reachable here, because
 * admin passkeys are bound to this address.
 */
export function gate(request: Request, env: GateEnv): Response | null {
	const key = env.DOCS_GATE_KEY;
	if (!key || request.headers.get("X-Docs-Gate") === key) return null;
	const url = new URL(request.url);
	if (url.pathname === "/_emdash/api/search") return Response.json({ error: "Sign in at docs.cloudposai.com" }, { status: 401 });
	if (url.pathname.startsWith("/_emdash/") || url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/brand/")) return null;
	return Response.redirect(`https://docs.cloudposai.com${url.pathname}${url.search}`, 302);
}

export default {
	...handler,
	fetch(request, env, ctx) {
		return gate(request, env as GateEnv) ?? handler.fetch!(request, env, ctx);
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
