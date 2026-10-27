// Live-mode sessions are sealed with AES-GCM under SESSION_SECRET and handed
// to the browser. The worker keeps no server-side state, and the browser can
// neither read the CloudPOS access token inside nor point it at another host.

import type { LiveSession } from "./sources/live.ts";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Sealed extends LiveSession {
  exp: number;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`cloudpos-ai-session:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function sealSession(session: LiveSession, secret: string, now = Date.now()): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body: Sealed = { ...session, exp: now + SESSION_TTL_MS };
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), enc.encode(JSON.stringify(body))));
  return `v1.${b64url(iv)}.${b64url(cipher)}`;
}

/** The session inside [token], or null when it is forged, corrupt or expired. */
export async function openSession(token: string | null | undefined, secret: string, now = Date.now()): Promise<LiveSession | null> {
  if (!token) return null;
  const [version, iv, cipher] = token.split(".");
  if (version !== "v1" || !iv || !cipher) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await keyFor(secret), unb64url(cipher));
    const body = JSON.parse(dec.decode(plain)) as Sealed;
    if (typeof body.exp !== "number" || body.exp < now) return null;
    const { exp: _exp, ...session } = body;
    return session;
  } catch {
    return null;
  }
}
