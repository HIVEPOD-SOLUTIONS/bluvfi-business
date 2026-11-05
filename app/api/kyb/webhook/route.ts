import { NextResponse } from "next/server";
import { handlePersonaWebhook } from "@/lib/kyb";

/**
 * Persona's webhook. It verifies Persona's signature on the raw body, then only uses the event as a prompt to fetch the real decision
 * from Persona's API, so nothing in the request body can verify a vendor or business on its own.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const r = await handlePersonaWebhook(raw, req.headers.get("persona-signature") ?? "");
  if (!r.ok) return NextResponse.json({ error: r.detail }, { status: r.detail === "Bad signature" ? 401 : 400 });
  return NextResponse.json({ ok: true, detail: r.detail });
}
