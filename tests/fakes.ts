import { ed25519KeyFromSeed, sha256 } from "../lib/crypto";
import { NEAR_AI_MODEL } from "../lib/config";
import type { Judged } from "../lib/nearai";
import { buildRequest, requestHash, type JudgeFacts } from "../lib/nearai-core";
import { makePolicy, DEFAULT_POLICY_BODY } from "../lib/policy";
import { services } from "../lib/services";
import { resetState, state } from "../lib/store";
import type { CallbackRecord, Invoice, Quote } from "../lib/types";

/** Test-only stand-ins for the outside services. The app itself never imports this file. */
const MODEL_KEY = ed25519KeyFromSeed(sha256("test-model-key"));
const NONCE = sha256("test-nonce");

export const sentCallbacks: { handle: string; channel: string; paymentId: string }[] = [];
export const quoteCalls: Invoice[] = [];
/** The deadline window (ms) each payout quote was asked for. */
export const quoteWindows: number[] = [];
export const depositsSubmitted: { txHash: string; depositAddress: string }[] = [];
export const behaviour = {
  ai: "pay" as "pay" | "hold" | "block" | "down",
  swap: "SUCCESS",
  tamper: false,
  kind: "provider_tee" as "provider_tee" | "gateway",
};

export async function fakeJudge(redacted: string, facts: JudgeFacts): Promise<Judged> {
  if (behaviour.ai === "down") throw new Error("NEAR AI chat failed: 503");
  const body = buildRequest(NEAR_AI_MODEL, redacted, facts);
  const judgment = { decision: behaviour.ai, riskScore: 5, summary: "Looks routine.", reasons: [] as string[] };
  const content = JSON.stringify(judgment);
  const raw = JSON.stringify({ id: "chat-1", choices: [{ message: { content } }] });
  // The signed text covers the exact response bytes; tampering changes the bytes after signing.
  const text = behaviour.kind === "gateway" ? `${requestHash(body)}:${sha256(raw)}` : `${NEAR_AI_MODEL}:${requestHash(body)}:${sha256(raw)}`;
  const sentRaw = behaviour.tamper ? raw.replace("pay", "block") : raw;
  return {
    requestBody: body,
    expectedNonce: NONCE,
    judgment,
    decision: {
      chatId: "chat-1",
      model: NEAR_AI_MODEL,
      content,
      rawResponse: sentRaw,
      signatureKind: behaviour.kind,
      text,
      signature: MODEL_KEY.sign(text),
      signingAddress: MODEL_KEY.publicKeyHex,
      attestation: {
        model: NEAR_AI_MODEL, nonce: NONCE, signingAddress: MODEL_KEY.publicKeyHex, signingAlgo: "ed25519",
        gpuEvidence: { arch: "HOPPER", nonce: NONCE, verified: true, note: "" },
        cpuEvidence: { type: "intel-tdx", reportData: MODEL_KEY.publicKeyHex + NONCE, verified: true, note: "" },
        source: "live",
      },
      source: "live",
    },
  };
}

export function install() {
  behaviour.ai = "pay";
  behaviour.swap = "SUCCESS";
  behaviour.tamper = false;
  behaviour.kind = "provider_tee";
  sentCallbacks.length = 0;
  quoteCalls.length = 0;
  depositsSubmitted.length = 0;
  quoteWindows.length = 0;
  Object.assign(services, {
    redact: async (text: string) => ({ text, source: "local-regex" as const }),
    judge: fakeJudge,
    lookupSignals: async () => undefined,
    screenSanctions: async () => ({ status: "clear" as const, hits: [], note: "Fake: not on the list." }),
    quotePayout: async (inv: Invoice, _confidentiality?: unknown, deadlineMs?: number): Promise<Quote> => {
      quoteCalls.push(inv);
      quoteWindows.push(deadlineMs ?? 0);
      const deadline = Date.now() + (deadlineMs ?? 1800_000);
      return { depositAddress: `dep-${inv.invoiceNumber}`, amountIn: inv.amountUsd.toFixed(2), amountOut: inv.amountUsd.toFixed(2), deadline: new Date(deadline).toISOString(), timeWhenInactive: new Date(deadline + 3 * 86_400_000).toISOString(), source: "1click" };
    },
    swapStatus: async () => behaviour.swap,
    submitDeposit: async (txHash: string, depositAddress: string) => { depositsSubmitted.push({ txHash, depositAddress }); return true; },
    sendCallback: async (inv: Invoice, target: { channel: string; handle: string } | undefined, why: string, paymentId: string): Promise<CallbackRecord> => {
      sentCallbacks.push({ handle: target?.handle ?? "", channel: target?.channel ?? "", paymentId });
      return { channel: target?.channel ?? "email", handle: target?.handle ?? "", sentAt: new Date().toISOString(), message: why, status: "pending", delivered: "telegram" };
    },
  });
}

/** Fresh state with one vendor, one PO and the vendor on the allowlist. */
export function seed() {
  const s = resetState();
  s.vendors.push({
    name: "Northwind Cloud Ltd", domain: "northwind.io",
    verifiedContact: { channel: "telegram", handle: "555111" },
    payout: { chain: "near", asset: "USDC", address: "northwind.near" },
    paidInvoiceNumbers: [],
  });
  s.purchaseOrders.push({ po: "PO-1", vendorName: "Northwind Cloud Ltd", amountUsd: 1240 }, { po: "PO-2", vendorName: "Northwind Cloud Ltd", amountUsd: 900 }, { po: "PO-BIG", vendorName: "Northwind Cloud Ltd", amountUsd: 7000 });
  // No hold window by default so tests can approve a held payment straight away; tests/layer1.test.ts sets one.
  s.policies = [makePolicy(1, { ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0 })];
  return s;
}

export const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv", vendorName: "Northwind Cloud Ltd", vendorDomain: "northwind.io",
  vendorContact: { channel: "email", handle: "ap@northwind.io" },
  invoiceNumber: "INV-1", poNumber: "PO-1", amountUsd: 1240, asset: "USDC", chain: "near",
  payoutAddress: "northwind.near", text: "Managed hosting for November.", receivedAt: new Date().toISOString(), ...over,
});

export { state };
