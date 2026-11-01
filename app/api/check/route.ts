import { NextResponse } from "next/server";
import { publicCheck } from "@/lib/agent";
import { route } from "@/lib/http";
import type { CheckRequest } from "@/lib/types";
import { facilitator } from "@/lib/x402";

/**
 * Bluvfi Business Check as an x402 endpoint. No X-PAYMENT header -> HTTP 402 with the payment requirements.
 * The header is base64 JSON of the payment payload; the facilitator (PingPay Agent Pay, or any x402 facilitator
 * that supports NEAR) verifies it, the check runs, and the payment is settled before the verdict is returned.
 * Without a facilitator this endpoint refuses rather than accept unverified payment.
 */
export const POST = route(async (req) => {
  const f = facilitator();
  if (!f) return NextResponse.json({ error: "Bluvfi Business Check is not accepting payments until PINGPAY_API_KEY, or X402_FACILITATOR_URL and TREASURY_ACCOUNT, are set" }, { status: 503 });
  const requirements = await f.requirements(new URL(req.url).toString());
  const refuse = (error: string) => NextResponse.json({ x402Version: f.version, error, accepts: [requirements] }, { status: 402 });

  const header = req.headers.get("x-payment") ?? req.headers.get("payment-signature");
  if (!header) return refuse("X-PAYMENT header is required");
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return refuse("X-PAYMENT is not base64 JSON");
  }

  const verified = await f.verify(paymentPayload, requirements);
  if (!verified.ok) return refuse(`Payment not valid${verified.reason ? `: ${verified.reason}` : ""}`);

  const b = (await req.json().catch(() => ({}))) as CheckRequest;
  if (!b.payoutAddress) throw new Error("payoutAddress is required");
  const result = await publicCheck(b);

  const settled = await f.settle(paymentPayload, requirements);
  if (!settled.ok) return refuse(`Payment could not be settled${settled.reason ? `: ${settled.reason}` : ""}`);
  return { ...result, payment: { facilitator: f.name, transaction: settled.transaction } };
});
