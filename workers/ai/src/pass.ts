// The sign-in pass shared by ai.cloudposai.com and docs.cloudposai.com: a cookie
// on .cloudposai.com that cloudpos-ai-web sets after a CloudPOS sign-in, so the
// docs (proxy/src/pass.js, which verifies it) need no second login. Format
// "v1.<expiry ms>.<nonce>.<HMAC-SHA256 base64url>".

export const PASS_COOKIE = "cp_pass";
/** Same lifetime as an AI session (session.ts). */
export const PASS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function issuePass(secret: string, now = Date.now()): Promise<string> {
  const payload = `v1.${now + PASS_TTL_MS}.${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/** True when [value] is a pass signed with [secret] that has not expired. */
export async function verifyPass(value: string | null | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!value || !secret) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !(Number(parts[1]) > now)) return false;
  const expected = await sign(secret, parts.slice(0, 3).join("."));
  if (expected.length !== parts[3].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[3].charCodeAt(i);
  return diff === 0;
}

/** Set-Cookie for the pass on every cloudposai.com site; an empty value clears it. */
export function passCookie(value: string, domain: string): string {
  const age = value ? Math.floor(PASS_TTL_MS / 1000) : 0;
  return `${PASS_COOKIE}=${value}; Domain=${domain}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}
