import { NextResponse } from "next/server";
import { businessesFor } from "@/lib/business";
import { OWNER_EMAILS } from "@/lib/config";
import { clientKey, limited } from "@/lib/ratelimit";
import { COOKIE, issueSession, privySubject, SESSION_MAX_AGE } from "@/lib/session";
import { privyEmails } from "@/lib/team";

const withSession = async (subject: string) => {
  const value = await issueSession(subject);
  if (!value) throw new Error("BLUVFI_MASTER_KEY is not set");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
};

/**
 * Sign in with Privy: the browser sends Privy's access token; the server verifies it and finds the businesses the person's
 * verified email belongs to. One business signs them in; several make them choose; none means they can create one.
 */
export async function POST(req: Request) {
  if (limited(`login:${clientKey(req)}`, 10)) return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  const { accessToken, businessId } = (await req.json().catch(() => ({}))) as { accessToken?: string; businessId?: string };
  try {
    const emails = await privyEmails(String(accessToken ?? ""));
    const seen = new Set<string>();
    const mine = emails.flatMap((email) => businessesFor(email, OWNER_EMAILS).map((m) => ({ ...m, email }))).filter((m) => !seen.has(m.business.id) && seen.add(m.business.id));
    if (!mine.length) return NextResponse.json({ error: `${emails[0] ?? "That account"} is not on any business's team yet.`, signup: true }, { status: 401 });
    const pick = businessId ? mine.find((m) => m.business.id === businessId) : mine.length === 1 ? mine[0] : undefined;
    if (businessId && !pick) return NextResponse.json({ error: "You are not on that business's team." }, { status: 401 });
    if (!pick) return NextResponse.json({ choose: mine.map((m) => ({ id: m.business.id, name: m.business.name, role: m.role })) });
    return await withSession(privySubject(pick.business.id, pick.email));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
