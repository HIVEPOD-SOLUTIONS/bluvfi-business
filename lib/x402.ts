import { cfg } from "./business";
import { NEAR_USDC_CONTRACT } from "./chains";
import { PINGPAY_BASE } from "./config";

/**
 * Selling Bluvfi Business Check per call over x402. Two facilitators:
 *  - PingPay Agent Pay (PINGPAY_API_KEY): the buyer pays USDC on Base, PingPay settles it to us as USDC on NEAR
 *    through NEAR Intents. x402 v2: `prepare` gives a per-challenge Base deposit address, then `verify` and `settle`
 *    (docs: pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/x402-integration). Routes and shapes checked
 *    against the docs and staging; not yet run with a funded payment.
 *  - Any x402 v1 facilitator (X402_FACILITATOR_URL) that supports `network: "near"`, paying our treasury directly.
 */
export const PRICE_RAW = "10000"; // 0.01 USDC, 6 decimals

export interface Facilitator {
  name: string;
  version: 1 | 2;
  requirements(resource: string): Promise<Record<string, unknown>>;
  verify(paymentPayload: unknown, requirements: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
  settle(paymentPayload: unknown, requirements: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; transaction?: string }>;
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return (await r.json().catch(() => ({ error: `HTTP ${r.status} (not JSON)` }))) as Record<string, unknown>;
};

const DESCRIPTION = "Bluvfi Business Check: is this payee safe to pay?";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Is PingPay's facilitator actually served at PINGPAY_BASE? `GET /agentpay/x402/supported` (no key) must list
 * x402 v2 `exact` on Base. Checked 2026-11-01: https://staging.pingpay.io answers it; https://pay.pingpay.io (the
 * documented host) still serves its web app there and 404s the POST routes. A success is cached for 10 minutes.
 */
let supportedCache: { at: number; ok: boolean; note: string } | undefined;
export async function pingpaySupported(): Promise<{ ok: boolean; note: string }> {
  if (supportedCache && Date.now() - supportedCache.at < 10 * 60_000) return supportedCache;
  let res = { ok: false, note: "" };
  try {
    const r = await fetch(`${PINGPAY_BASE}/agentpay/x402/supported`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { kinds?: { x402Version?: number; scheme?: string; network?: string }[] };
    const kind = j.kinds?.find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === "eip155:8453");
    res = kind ? { ok: true, note: `PingPay at ${PINGPAY_BASE}: x402 v2, exact, Base USDC, settled to NEAR through NEAR Intents.` } : { ok: false, note: `${PINGPAY_BASE} does not list x402 v2 exact on Base.` };
  } catch {
    res = { ok: false, note: `${PINGPAY_BASE}/agentpay/x402/supported did not answer JSON; the facilitator is not served there. Set PINGPAY_BASE_URL (e.g. https://staging.pingpay.io).` };
  }
  if (res.ok) supportedCache = { at: Date.now(), ...res }; // a failure is re-checked on the next call
  return res;
}

function pingpay(): Facilitator {
  const h = { "X-Api-Key": cfg().PINGPAY_API_KEY };
  const url = (p: string) => `${PINGPAY_BASE}/agentpay/x402/${p}`;
  return {
    name: "PingPay Agent Pay",
    version: 2,
    async requirements(resource) {
      const sup = await pingpaySupported();
      if (!sup.ok) throw new Error(sup.note);
      // Prepare returns a flat challenge: payTo (a Base deposit address for this challenge), amount, asset, network,
      // scheme, maxTimeoutSeconds, expiresAt, refundTo, agentPayChallengeId. Verify/settle want exactly the
      // `accepted` requirements from it.
      const prep = await post(url("prepare"), { amountOut: PRICE_RAW, challengeIdentity: "POST /api/check", description: DESCRIPTION }, h);
      if (!prep.payTo) throw new Error(`PingPay prepare failed: ${String(prep.error ?? prep.code ?? JSON.stringify(prep).slice(0, 200))}`);
      return {
        scheme: String(prep.scheme ?? "exact"),
        network: String(prep.network ?? "eip155:8453"),
        asset: String(prep.asset ?? BASE_USDC),
        amount: String(prep.amount ?? prep.minAmountIn),
        payTo: String(prep.payTo),
        maxTimeoutSeconds: Number(prep.maxTimeoutSeconds ?? 300),
        extra: { ...((prep.extra as object | undefined) ?? {}), agentPayChallengeId: prep.agentPayChallengeId, expiresAt: prep.expiresAt, resource },
      };
    },
    async verify(paymentPayload, paymentRequirements) {
      const j = await post(url("verify"), { x402Version: 2, paymentPayload, paymentRequirements }, h);
      return { ok: j.isValid === true, reason: String(j.invalidReason ?? j.error ?? "") };
    },
    async settle(paymentPayload, paymentRequirements) {
      const j = await post(url("settle"), { x402Version: 2, paymentPayload, paymentRequirements }, h);
      return { ok: j.success === true, reason: String(j.errorReason ?? j.error ?? ""), transaction: j.transaction ? String(j.transaction) : undefined };
    },
  };
}

function generic(): Facilitator {
  return {
    name: cfg().X402_FACILITATOR_URL,
    version: 1,
    async requirements(resource) {
      return {
        scheme: "exact", network: "near", maxAmountRequired: PRICE_RAW, resource, description: DESCRIPTION,
        mimeType: "application/json", payTo: cfg().TREASURY_ACCOUNT, maxTimeoutSeconds: 60, asset: NEAR_USDC_CONTRACT,
      };
    },
    async verify(paymentPayload, paymentRequirements) {
      const j = await post(`${cfg().X402_FACILITATOR_URL}/verify`, { x402Version: 1, paymentPayload, paymentRequirements });
      return { ok: j.isValid === true, reason: String(j.invalidReason ?? "") };
    },
    async settle(paymentPayload, paymentRequirements) {
      const j = await post(`${cfg().X402_FACILITATOR_URL}/settle`, { x402Version: 1, paymentPayload, paymentRequirements });
      return { ok: j.success === true, reason: String(j.errorReason ?? "") };
    },
  };
}

/** The configured facilitator, or null when Check cannot take payments yet. */
export function facilitator(): Facilitator | null {
  if (cfg().PINGPAY_API_KEY) return pingpay();
  if (cfg().X402_FACILITATOR_URL && cfg().TREASURY_ACCOUNT) return generic();
  return null;
}
