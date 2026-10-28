// The sign-in pass shared by docs.cloudposai.com and ai.cloudposai.com: a cookie
// on .cloudposai.com set by the AI site after a CloudPOS sign-in. Format
// "v1.<expiry ms>.<nonce>.<HMAC-SHA256 base64url>"; the same code lives in
// workers/ai/src/pass.ts, which issues it.

export const PASS_COOKIE = "cp_pass";

const encoder = new TextEncoder();

function base64url(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret, payload) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

/** True when [value] is a pass signed with [secret] that has not expired. */
export async function verifyPass(value, secret, now = Date.now()) {
	if (!value || !secret) return false;
	const parts = value.split(".");
	if (parts.length !== 4 || parts[0] !== "v1" || !(Number(parts[1]) > now)) return false;
	const expected = await sign(secret, parts.slice(0, 3).join("."));
	// Compare in constant time, as the signature is attacker-supplied.
	if (expected.length !== parts[3].length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[3].charCodeAt(i);
	return diff === 0;
}

export function cookieValue(request, name) {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return "";
}
