import { NextResponse } from "next/server";
import { createBusiness } from "@/lib/business";
import { SIGNUP_OPEN } from "@/lib/config";
import { clientKey, limited } from "@/lib/ratelimit";
import { COOKIE, issueSession, privySubject, SESSION_MAX_AGE, cookieSecure } from "@/lib/session";
import { privyEmails } from "@/lib/team";

/**
 * Create a business. The person proves who they are with Privy; the verified email becomes the business's first owner.
 * Nothing else is created yet: the owner sets up the treasury from the app, with their own wallet.
 */
export async function POST(req: Request) {
  if (!SIGNUP_OPEN) return NextResponse.json({ error: "New businesses are not being onboarded on this platform right now." }, { status: 403 });
  if (limited(`signup:${clientKey(req)}`, 5)) return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  const { accessToken, businessName } = (await req.json().catch(() => ({}))) as { accessToken?: string; businessName?: string };
  try {
    const [email] = await privyEmails(String(accessToken ?? ""));
    if (!email) throw new Error("Your Privy account has no verified email. Sign in with email or Google.");
    const business = createBusiness(String(businessName ?? ""), email);
    const value = await issueSession(privySubject(business.id, email));
    if (!value) throw new Error("BLUVFI_MASTER_KEY is not set");
    const res = NextResponse.json({ ok: true, business: { id: business.id, name: business.name } });
    res.cookies.set(COOKIE, value, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: SESSION_MAX_AGE });
    return res;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
