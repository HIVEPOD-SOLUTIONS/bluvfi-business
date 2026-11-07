import { NextResponse } from "next/server";
import { purchases, requestCardPurchase, type PurchaseInput } from "@/lib/cards";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** The card purchases so far. No card numbers: they are never stored. */
export const GET = route(async (req) => {
  await requireSigner(req);
  return { purchases: purchases() };
});

/**
 * The agent (or a signer) asks for a one-time card for one purchase: { merchant, merchantUrl?, amountUsd, reason }. If the policy lets it
 * through without approval, the card's number comes back in this response, once; it is not stored and is never shown again.
 */
export const POST = route(async (req) => {
  const signer = await requireSigner(req);
  const out = await requestCardPurchase(await body<PurchaseInput>(req), signer);
  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
});
