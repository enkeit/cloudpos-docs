// Abuse protection that keeps AI cost bounded without getting in the way of
// real customers:
//  - Guests prove they're human once with Cloudflare Turnstile (invisible for
//    most people) and get a signed 2-hour pass tied to their visitor id.
//  - Daily fair-use caps per guest IP, per guest browser and per signed-in user.
//  - A global daily ceiling for guests as the last-resort cost backstop.

const enc = new TextEncoder();
const GUEST_PASS_TTL_MS = 2 * 60 * 60 * 1000;

export const DAILY_LIMITS = {
  guestPerIp: 80,
  guestPerVisitor: 60,
  userPerDay: 500,
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(`cloudpos-ai-guest-pass:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2) return null;
  return Uint8Array.from(text.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** A pass proving this visitor solved Turnstile recently. */
export async function issueGuestPass(visitorId: string, secret: string, now = Date.now()): Promise<{ pass: string; expiresAt: number }> {
  const exp = now + GUEST_PASS_TTL_MS;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${visitorId}.${exp}`));
  return { pass: `gp1.${exp}.${hex(sig)}`, expiresAt: exp };
}

export async function verifyGuestPass(pass: string | null, visitorId: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!pass || !visitorId) return false;
  const [version, expText, sigText] = pass.split(".");
  const exp = Number(expText);
  const sig = unhex(sigText ?? "");
  if (version !== "gp1" || !Number.isFinite(exp) || exp < now || !sig) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${visitorId}.${exp}`));
}

/** Server-side Turnstile check (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
export async function verifyTurnstile(secret: string, token: string, ip: string | null, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  if (!res.ok) return false;
  const body = (await res.json()) as { success?: boolean };
  return body.success === true;
}

/**
 * Counts one use against a daily budget and says whether it is still within
 * it. KV is eventually consistent, so this is a fair-use cap, not an exact one.
 */
export async function withinDaily(kv: KVNamespace | undefined, key: string, limit: number, now = new Date()): Promise<boolean> {
  if (!kv || !limit) return true;
  const k = `daily:${now.toISOString().slice(0, 10)}:${key}`;
  const used = Number((await kv.get(k)) ?? "0");
  if (used >= limit) return false;
  await kv.put(k, String(used + 1), { expirationTtl: 172_800 });
  return true;
}
