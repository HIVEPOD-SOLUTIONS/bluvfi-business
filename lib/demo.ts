import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Balance } from "./chain";
import { ed25519KeyFromSeed, sha256 } from "./crypto";
import type { CounterpartySignals } from "./fraud";
import type { Judged, NearAiBundle } from "./nearai";
import { verifyNearAiBundle } from "./nearai";
import { buildRequest, requestHash, type JudgeFacts } from "./nearai-core";
import type { CallbackRecord, Invoice, Quote } from "./types";

/**
 * Demo mode (BLUVFI_DEMO=1): the outside services, replaced by fixtures so the full flow runs with no keys
 * and no funds. Nothing here is used when demo mode is off.
 *
 * NEAR AI reviews are replayed from `fixtures/nearai/<request hash>.json`. Each file is either a real NEAR AI
 * response recorded with `npm run fixtures:record` (source "recorded": every check runs again, including the
 * Intel TDX and NVIDIA evidence) or one signed locally with the demo key below (source "demo-fixture": the
 * signature and request/response binding are checked for real, hardware attestation is not claimed).
 */
export const FIXTURE_DIR = join(process.cwd(), "fixtures", "nearai");

/** The demo model key. Public on purpose: anyone can re-check a demo-fixture signature with it. */
export const DEMO_MODEL_KEY = ed25519KeyFromSeed(sha256("bluvfi-business demo model key"));

export const fixturePath = (requestBody: unknown) => join(FIXTURE_DIR, `${requestHash(requestBody).slice(0, 32)}.json`);

export function saveFixture(b: NearAiBundle) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(b.requestBody), JSON.stringify(b, null, 2) + "\n");
}

/** A NEAR AI-shaped review signed with the demo key, in exactly the format NEAR AI uses for provider_tee. */
export function demoBundle(requestBody: { model: string }, judgment: object): NearAiBundle {
  const reqHash = requestHash(requestBody);
  const nonce = sha256(`demo-nonce:${reqHash}`);
  const rawResponse = JSON.stringify({
    id: `chatcmpl-demo-${reqHash.slice(0, 12)}`,
    object: "chat.completion",
    model: requestBody.model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(judgment) }, finish_reason: "stop" }],
  });
  const text = `${requestBody.model}:${reqHash}:${sha256(rawResponse)}`;
  return {
    model: requestBody.model,
    nonce,
    requestBody,
    attestationReport: { model_attestations: [{ signing_address: DEMO_MODEL_KEY.publicKeyHex, request_nonce: nonce }] },
    rawResponse,
    signatureResponse: { text, signature: DEMO_MODEL_KEY.sign(text), signing_address: DEMO_MODEL_KEY.publicKeyHex, signature_kind: "provider_tee" },
    recordedAt: "2026-11-01T00:00:00.000Z",
    source: "demo-fixture",
  };
}

async function judge(model: string, redactedText: string, facts: JudgeFacts): Promise<Judged> {
  const body = buildRequest(model, redactedText, facts);
  const file = fixturePath(body);
  if (!existsSync(file)) throw new Error("demo mode only replays recorded reviews, and there is none for this invoice");
  return verifyNearAiBundle(JSON.parse(readFileSync(file, "utf8")) as NearAiBundle);
}

/** Public facts a chain lookup would return for the demo addresses. Unknown addresses look brand new. */
const SIGNALS: Record<string, CounterpartySignals> = {
  "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed": { ageDays: 912, isContract: false, codeChangedRecently: false, priorInteractions: 0, source: "near-rpc" },
  "acme-logistics.near": { ageDays: 640, isContract: false, codeChangedRecently: false, priorInteractions: 0, source: "near-rpc" },
};
const NEW_ACCOUNT: CounterpartySignals = { ageDays: 2, isContract: false, codeChangedRecently: null, priorInteractions: 0, source: "near-rpc" };

const quote = (key: string, amountUsd: number): Quote => ({
  depositAddress: `demo-deposit-${sha256(key).slice(0, 20)}`,
  amountIn: (amountUsd * 1.002).toFixed(2),
  amountOut: amountUsd.toFixed(2),
  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  source: "demo-fixture",
});

/** Stand-ins for `services` (lib/services.ts) in demo mode. */
export const demoServices = (model: string) => ({
  judge: (redactedText: string, facts: JudgeFacts) => judge(model, redactedText, facts),
  lookupSignals: async (address: string) => SIGNALS[address.toLowerCase()] ?? NEW_ACCOUNT,
  treasuryBalances: async (): Promise<Balance[]> => [
    { chain: "near", asset: "USDC", amount: 48_250, usd: true },
    { chain: "near", asset: "NEAR", amount: 12.5, usd: false },
  ],
  quotePayout: async (inv: Invoice): Promise<Quote> => quote(`pay:${inv.invoiceNumber}`, inv.amountUsd),
  quoteReceivable: async (amountUsd: number, fromChain: string, _refundTo: string, payTo: string): Promise<Quote> => quote(`recv:${fromChain}:${payTo}:${amountUsd}`, amountUsd),
  quoteForWidget: async (request: Record<string, unknown>, amountUsd: number, payTo: string) => {
    const q = quote(`widget:${payTo}:${amountUsd}:${String(request.originAsset)}`, amountUsd);
    const raw = BigInt(Math.round(amountUsd * 1.002 * 1e6)).toString();
    return request.dry === false
      ? { depositAddress: q.depositAddress, amountIn: raw, amountInFormatted: q.amountIn, amountOut: BigInt(Math.round(amountUsd * 1e6)).toString(), amountOutFormatted: q.amountOut, deadline: q.deadline, timeEstimate: 20 }
      : { amountIn: raw, amountInFormatted: q.amountIn, amountOut: BigInt(Math.round(amountUsd * 1e6)).toString(), amountOutFormatted: q.amountOut, timeEstimate: 20 };
  },
  swapStatus: async () => "SUCCESS",
  sendCallback: async (inv: Invoice, target: { channel: string; handle: string } | undefined, why: string): Promise<CallbackRecord> => ({
    channel: target?.channel ?? "email",
    handle: target?.handle ?? "(no verified contact on file)",
    sentAt: new Date().toISOString(),
    message: `Hi, this is the finance agent. Invoice ${inv.invoiceNumber} for $${inv.amountUsd.toLocaleString()} ${why}. Did you send it? Reply YES ${inv.invoiceNumber} or NO ${inv.invoiceNumber}.`,
    status: "pending",
    delivered: "demo",
  }),
  payX402: async (url: string) => ({ ok: true, status: 200, priceUsd: 0.01, body: { demo: true, url }, note: "Demo mode: no payment was made." }),
});
