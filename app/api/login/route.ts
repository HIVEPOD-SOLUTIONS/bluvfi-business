import { NextResponse } from "next/server";
import { clientKey, limited } from "@/lib/ratelimit";
import { COOKIE, login, SESSION_MAX_AGE, cookieSecure } from "@/lib/session";

export async function POST(req: Request) {
  if (limited(`login:${clientKey(req)}`, 10)) return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  const value = await login(String(token ?? ""));
  if (!value) return NextResponse.json({ error: "That token was not recognised." }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, value, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
