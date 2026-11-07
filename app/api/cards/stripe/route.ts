import { NextResponse } from "next/server";
import { STRIPE_API_VERSION } from "@/lib/config";
import { bizFromRequest } from "@/lib/business";
import { handleStripeWebhook } from "@/lib/cards";

/**
 * Stripe Issuing's real-time authorization webhook (public; it checks Stripe's signature itself). Every charge on a one-time card is
 * approved or declined here within Stripe's two seconds, against the purchase the card was made for. Each business points its own Stripe
 * account here with ?b=<its id> (the operator's own business without it), and only that business's signing secret is accepted.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await handleStripeWebhook(raw, req.headers.get("stripe-signature"), bizFromRequest(req));
    return NextResponse.json(r.body, { status: r.status, headers: { "Stripe-Version": STRIPE_API_VERSION } });
  } catch {
    // Anything unexpected declines: Stripe reads a non-answer by its timeout setting, so answer "no" explicitly.
    return NextResponse.json({ approved: false }, { status: 200, headers: { "Stripe-Version": STRIPE_API_VERSION } });
  }
}
