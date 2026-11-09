import { NextResponse } from "next/server";
import { confirm } from "@/lib/agent-chat";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** Run what a person confirmed. Only the saved request runs, and only for the person who asked: nothing sent here changes it. */
export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ id?: string }>(req);
  // A one-time card's number may be in this answer, shown once: never cache it.
  return NextResponse.json(await confirm(String(b.id ?? ""), by), { headers: { "cache-control": "no-store" } });
});
