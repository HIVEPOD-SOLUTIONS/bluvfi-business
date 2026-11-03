import { MASTER_KEY, SIGNERS } from "./config";
import { BIZ_ID, DEFAULT_BIZ } from "./tenant";

/**
 * Signer sessions: a cookie `subject.expiry.hmac`, HMAC-SHA256 under a key derived from BLUVFI_MASTER_KEY.
 * Web Crypto only, so the same code runs in proxy.ts and in route handlers.
 *
 * The subject says who and for which business: a token signer is just their name (they belong to the operator's own
 * business), and a Privy signer is `<business id>|<email>`. Either way a session counts only while the person is
 * still a signer of that business, so removing someone from the team ends their session at once.
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

/** The session subject for a person who signed in with Privy to a business. */
export const privySubject = (biz: string, email: string) => `${biz}|${email}`;

/** A session cookie value for a subject already identified (by token, or by a verified Privy login). */
export async function issueSession(subject: string): Promise<string | null> {
  if (!MASTER_KEY) return null;
  const body = `${subject}.${Date.now() + TTL_MS}`;
  return `${body}.${await mac(body)}`;
}

/** Exchange a signer token for a session cookie value, or null if no signer has that token. */
export async function login(token: string): Promise<string | null> {
  const hit = SIGNERS.find((s) => safeEqual(s.token, token));
  return hit ? issueSession(hit.name) : null;
}

/** The signer and business named by a valid, unexpired session cookie value. */
export async function verifySessionFull(value: string | undefined | null): Promise<{ biz: string; name: string } | null> {
  if (!value || !MASTER_KEY) return null;
  const i = value.lastIndexOf(".");
  const body = value.slice(0, i);
  if (i < 0 || !safeEqual(await mac(body), value.slice(i + 1))) return null;
  const [subject, exp] = [body.slice(0, body.lastIndexOf(".")), Number(body.slice(body.lastIndexOf(".") + 1))];
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  if (SIGNERS.some((s) => s.name === subject)) return { biz: DEFAULT_BIZ, name: subject };
  const bar = subject.indexOf("|");
  if (bar < 0) return null;
  const [biz, email] = [subject.slice(0, bar), subject.slice(bar + 1)];
  if (biz !== DEFAULT_BIZ && !BIZ_ID.test(biz)) return null;
  // A Privy signer counts only while still on that business's team (lib/team.ts).
  return (await import("./team")).isMemberOf(biz, email) ? { biz, name: email } : null;
}

/** The signer named by a valid session cookie value. */
export async function verifySession(value: string | undefined | null): Promise<string | null> {
  return (await verifySessionFull(value))?.name ?? null;
}

/** The session cookie from a request. Browsers send it percent-encoded (a Privy subject has an @ and a |). */
export const cookieFrom = (req: Request) => {
  const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  try {
    return raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    return undefined;
  }
};

/** The signer making this request. Throws if there is no valid session. */
export async function requireSigner(req: Request): Promise<string> {
  const who = await verifySession(cookieFrom(req));
  if (!who) throw new Error("Sign in as a signer first");
  return who;
}

export const SESSION_MAX_AGE = TTL_MS / 1000;
