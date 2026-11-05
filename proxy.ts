import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifySession } from "@/lib/session";

/**
 * Everything is behind a signer session except what must be public: the sign-in page, the pay-link
 * pages and APIs (clients paying an invoice), Bluvfi Business Check (paid per call over x402, plus a rate-limited
 * free tier for the website), the chat-channel webhooks (which verify their own secrets), the public
 * ledger page, the API description, and the app icon and manifest.
 */
const PUBLIC = [
  /^\/login$/, /^\/api\/login$/, /^\/api\/login\/privy$/, /^\/api\/signup$/, /^\/api\/logout$/,
  /^\/pay\//, /^\/api\/pay\//,
  /^\/check$/, /^\/api\/check(\/try)?$/, /^\/api\/openapi$/,
  /^\/ledger$/,
  /^\/view$/, /^\/api\/audit\/open$/,
  /^\/api\/telegram\/webhook$/, /^\/api\/twilio\/voice$/, /^\/api\/kyb\/webhook$/, /^\/api\/claims\/verify$/, /^\/verify-proof$/,
  // Scheduled polling: these check a bearer secret or a signer session themselves.
  /^\/api\/agentmarket\/poll$/, /^\/api\/settlement\/poll$/,
  /^\/apple-icon$/, /^\/manifest\.webmanifest$/,
  // Treasury setup: its API checks a signer session, or the one-time setup code before any signer exists.
  /^\/setup$/, /^\/api\/setup$/,
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  if (await verifySession(req.cookies.get(COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in as a signer first" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)"],
};
