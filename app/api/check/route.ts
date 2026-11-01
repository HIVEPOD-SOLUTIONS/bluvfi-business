import { NextResponse } from "next/server";
import { publicCheck } from "@/lib/agent";
import { NEAR_USDC_CONTRACT } from "@/lib/chains";
import { TREASURY_ACCOUNT, X402_FACILITATOR_URL } from "@/lib/config";
import { route } from "@/lib/http";
import type { CheckRequest } from "@/lib/types";

const PRICE = "10000"; // 0.01 USDC, 6 decimals

/**
 * Proofpay Check as an x402 endpoint (v1 shapes from the x402 specification).
 * No X-PAYMENT header -> HTTP 402 {x402Version, error, accepts}. The header is base64 JSON of the payment payload;
 * the facilitator at X402_FACILITATOR_URL verifies it (POST /verify) and settles it (POST /settle) before the verdict
 * is returned. Without a facilitator this endpoint refuses rather than accept unverified payment.
 * The spec lists no NEAR network: `network: "near"` only works with a facilitator that supports it.
 */
export const POST = route(async (req) => {
  if (!X402_FACILITATOR_URL || !TREASURY_ACCOUNT) return NextResponse.json({ error: "Proofpay Check is not accepting payments until X402_FACILITATOR_URL and TREASURY_ACCOUNT are set" }, { status: 503 });
  const requirements = {
    scheme: "exact",
    network: "near",
    maxAmountRequired: PRICE,
    resource: new URL(req.url).toString(),
    description: "Proofpay Check: is this payee safe to pay?",
    mimeType: "application/json",
    payTo: TREASURY_ACCOUNT,
    maxTimeoutSeconds: 60,
    asset: NEAR_USDC_CONTRACT,
  };
  const refuse = (error: string) => NextResponse.json({ x402Version: 1, error, accepts: [requirements] }, { status: 402 });

  const header = req.headers.get("x-payment");
  if (!header) return refuse("X-PAYMENT header is required");
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return refuse("X-PAYMENT is not base64 JSON");
  }
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirements });
  const post = (path: string) =>
    fetch(`${X402_FACILITATOR_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });

  const verified = (await (await post("/verify")).json().catch(() => ({}))) as { isValid?: boolean; invalidReason?: string };
  if (!verified.isValid) return refuse(`Payment not valid${verified.invalidReason ? `: ${verified.invalidReason}` : ""}`);

  const b = (await req.json().catch(() => ({}))) as CheckRequest;
  if (!b.payoutAddress) throw new Error("payoutAddress is required");
  const result = await publicCheck(b);

  const settled = (await (await post("/settle")).json().catch(() => ({}))) as { success?: boolean; errorReason?: string };
  if (!settled.success) return refuse(`Payment could not be settled${settled.errorReason ? `: ${settled.errorReason}` : ""}`);
  return result;
});
