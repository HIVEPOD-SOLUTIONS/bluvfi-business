import { NextResponse } from "next/server";
import { approveCardPurchase, closeCardPurchase } from "@/lib/cards";
import { body, route, type Ctx } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** A signer approves a purchase that needed approval (the approval that completes it gets the card's number, once), or closes one. */
export const POST = route<Ctx<"id">>(async (req, { params }) => {
  const { id } = await params;
  const signer = await requireSigner(req);
  const { action } = await body<{ action?: "approve" | "close" }>(req);
  if (action === "approve") return NextResponse.json(await approveCardPurchase(id, signer), { headers: { "cache-control": "no-store" } });
  if (action === "close") return { purchase: await closeCardPurchase(id, `closed by ${signer}`) };
  throw new Error("Unknown action");
});
