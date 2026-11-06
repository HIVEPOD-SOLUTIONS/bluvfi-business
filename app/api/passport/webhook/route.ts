import { NextResponse } from "next/server";
import { handleSelfWebhook } from "@/lib/passport";

/**
 * Self's webhook (signed by Svix). The signature is checked on the raw body, then the proof inside is re-verified with Self's verifier,
 * so nothing in the request can verify a party on its own.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const headers = Object.fromEntries(["svix-id", "svix-timestamp", "svix-signature"].map((h) => [h, req.headers.get(h) ?? ""]));
  const r = await handleSelfWebhook(raw, headers);
  if (!r.ok) return NextResponse.json({ error: r.detail }, { status: r.detail === "Bad signature" ? 401 : 400 });
  return NextResponse.json({ ok: true, detail: r.detail });
}
