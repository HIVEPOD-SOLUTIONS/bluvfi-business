import { MASTER_KEY, SIGNERS } from "./config";

/**
 * Signer sessions: a cookie `name.expiry.hmac`, HMAC-SHA256 under a key derived from BLUVFI_MASTER_KEY.
 * Web Crypto only, so the same code runs in proxy.ts and in route handlers.
 */
export const COOKIE = "bluvfi_session";
const TTL_MS = 12 * 3600_000;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function mac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`bluvfi-business-session:${MASTER_KEY}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Exchange a signer token for a session cookie value, or null if no signer has that token. */
export async function login(token: string): Promise<string | null> {
  if (!MASTER_KEY) return null;
  const hit = SIGNERS.find((s) => safeEqual(s.token, token));
  if (!hit) return null;
  const body = `${hit.name}.${Date.now() + TTL_MS}`;
  return `${body}.${await mac(body)}`;
}

/** The signer named by a valid, unexpired session cookie value. */
export async function verifySession(value: string | undefined | null): Promise<string | null> {
  if (!value || !MASTER_KEY) return null;
  const i = value.lastIndexOf(".");
  const body = value.slice(0, i);
  if (i < 0 || !safeEqual(await mac(body), value.slice(i + 1))) return null;
  const [name, exp] = [body.slice(0, body.lastIndexOf(".")), Number(body.slice(body.lastIndexOf(".") + 1))];
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return SIGNERS.some((s) => s.name === name) ? name : null;
}

export const cookieFrom = (req: Request) =>
  req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

/** The signer making this request. Throws if there is no valid session. */
export async function requireSigner(req: Request): Promise<string> {
  const who = await verifySession(cookieFrom(req));
  if (!who) throw new Error("Sign in as a signer first");
  return who;
}

export const SESSION_MAX_AGE = TTL_MS / 1000;
