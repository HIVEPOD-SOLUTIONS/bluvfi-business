import { createRemoteJWKSet, jwtVerify } from "jose";
import { getBusiness, normalizeEmail, saveRegistry, validEmail, type Member } from "./business";
import { OWNER_EMAILS, PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_LOGIN, SIGNER_NAMES } from "./config";
import { currentBiz, DEFAULT_BIZ } from "./tenant";

/**
 * Who may sign, per business. A signer is named in the session cookie, and is one of:
 *  - a token signer (BLUVFI_SIGNERS): people the operator configured, who belong to the operator's own (default) business
 *    and are owners there;
 *  - a Privy signer: someone who signs in with an email or Google login and is on a business's team. A signer's name is
 *    their verified email. The first owner of a business is whoever created it; owners add approvers on the Team page.
 *    In the default business, BLUVFI_OWNER_EMAIL also names owners.
 * Privy proves who someone is; the team list says what they may do. Logging in with Privy alone grants nothing.
 */
const AUTH_URL = process.env.PRIVY_AUTH_URL ?? "https://auth.privy.io";
const API_URL = process.env.PRIVY_API_URL ?? "https://api.privy.io";

export type { Member };

/** The team of a business: stored members, plus (for the default business) the owners named in the environment. */
export function membersOf(biz: string): Member[] {
  const stored = getBusiness(biz)?.team ?? [];
  if (biz !== DEFAULT_BIZ) return stored;
  return [...OWNER_EMAILS.map((email): Member => ({ email, role: "owner" })), ...stored.filter((m) => !OWNER_EMAILS.includes(m.email))];
}
export const members = () => membersOf(currentBiz());

/** Is this email on that business's team? (Removing someone ends their session at once.) */
export const isMemberOf = (biz: string, email: string) => membersOf(biz).some((m) => m.email === email);

/** Every name that may approve in a business: token signers (default business only) and the team. */
export const signerNamesOf = (biz: string) => [...(biz === DEFAULT_BIZ ? SIGNER_NAMES : []), ...membersOf(biz).map((m) => m.email)];
export const signerNames = () => signerNamesOf(currentBiz());

/** Token signers are owners of the default business; a Privy signer is an owner if their role says so. */
export const isOwner = (name: string) => (currentBiz() === DEFAULT_BIZ && SIGNER_NAMES.includes(name)) || members().some((m) => m.email === name && m.role === "owner");

/** How many distinct signers a policy change needs: APPROVAL_THRESHOLD_SIGNERS (default 2), or fewer if the team is smaller. */
export const approvalThreshold = () => Math.max(1, Math.min(Number(process.env.APPROVAL_THRESHOLD_SIGNERS ?? 2), signerNames().length || 1));

export function addMember(by: string, rawEmail: string, role: Member["role"] = "approver"): Member {
  if (!isOwner(by)) throw new Error("Only an owner can add people");
  const email = normalizeEmail(rawEmail);
  if (!validEmail(email)) throw new Error("Enter a valid email address");
  if (members().some((m) => m.email === email)) throw new Error("That person is already on the team");
  const biz = getBusiness(currentBiz());
  if (!biz) throw new Error("Unknown business");
  const m: Member = { email, role, addedBy: by, addedAt: new Date().toISOString() };
  biz.team.push(m);
  saveRegistry();
  return m;
}

export function removeMember(by: string, rawEmail: string) {
  if (!isOwner(by)) throw new Error("Only an owner can remove people");
  const email = normalizeEmail(rawEmail);
  if (currentBiz() === DEFAULT_BIZ && OWNER_EMAILS.includes(email)) throw new Error("Owners are set by BLUVFI_OWNER_EMAIL and cannot be removed here");
  const biz = getBusiness(currentBiz());
  const target = biz?.team.find((m) => m.email === email);
  if (!biz || !target) throw new Error("That person is not on the team");
  if (target.role === "owner" && biz.team.filter((m) => m.role === "owner").length < 2 && currentBiz() !== DEFAULT_BIZ) throw new Error("A business needs at least one owner. Add another owner first.");
  biz.team = biz.team.filter((m) => m.email !== email);
  saveRegistry();
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** The verified emails of the person holding this Privy access token. Throws if the token is not Privy's, for this app, and current. */
export async function privyEmails(accessToken: string): Promise<string[]> {
  if (!PRIVY_LOGIN) throw new Error("Sign in with Privy is not set up. Set PRIVY_APP_ID and PRIVY_APP_SECRET.");
  jwks ??= createRemoteJWKSet(new URL(`${AUTH_URL}/api/v1/apps/${PRIVY_APP_ID}/jwks.json`));
  let did: string;
  try {
    const { payload } = await jwtVerify(accessToken, jwks, { issuer: "privy.io", audience: PRIVY_APP_ID, algorithms: ["ES256"] });
    if (!payload.sub) throw new Error("no subject");
    did = payload.sub;
  } catch {
    throw new Error("That Privy login could not be verified. Sign in again.");
  }
  const res = await fetch(`${API_URL}/v1/users/${encodeURIComponent(did)}`, {
    headers: { "privy-app-id": PRIVY_APP_ID, authorization: `Basic ${Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`Privy would not look up this user (${res.status}). Check PRIVY_APP_SECRET.`);
  const user = (await res.json()) as { linked_accounts?: { type: string; address?: string; email?: string }[] };
  const out = (user.linked_accounts ?? [])
    .map((a) => (a.type === "email" ? a.address : a.type === "google_oauth" || a.type === "github_oauth" ? a.email : undefined))
    .filter((e): e is string => !!e)
    .map(normalizeEmail);
  return [...new Set(out)];
}
