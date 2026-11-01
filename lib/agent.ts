import { canonical, mlDsaSign, mlDsaVerify, sha256, encrypt } from "./crypto";
import { NEAR_AI_MODEL, SIGNER_NAMES } from "./config";
import { runFraudChecks, runPublicCheck, worst } from "./fraud";
import type { Judged } from "./nearai";
import { attestationTrusted, computeFacts, unavailablePanel, verifyDecision } from "./nearai-core";
import { evaluatePolicy, needsApproval } from "./policy";
import { services } from "./services";
import { currentPolicy, dataKey, fraudContext, pqSeed, prefetchCounterparty, spentTodayUsd, state } from "./store";
import type { CheckRequest, CheckResponse, CheckResult, Confidentiality, Invoice, Payment, PaymentStatus } from "./types";

const uid = (p: string) => `${p}-${sha256(`${p}${Date.now()}${Math.random()}`).slice(0, 8)}`;

/**
 * The agent's whole job, in one place. Principle: the AI has judgment, never authority.
 * Final status = the strictest of (policy gate, fraud checks, AI recommendation).
 * The AI can tighten a result (pay -> hold) but can never loosen one.
 */
export async function processInvoice(inv: Invoice, confidentiality: Confidentiality = "basic"): Promise<Payment> {
  const s = state();
  const policy = currentPolicy();

  const red = await services.redact(inv.text);
  const facts = computeFacts(inv, s.vendors, s.purchaseOrders);
  // If the private model cannot be reached the payment is held for a human; it is never waved through.
  let judged: Judged | null = null;
  let aiError = "";
  try {
    judged = await services.judge(red.text, facts);
  } catch (e) {
    aiError = (e as Error).message;
  }
  const judgment = judged?.judgment ?? {
    decision: "hold" as const,
    riskScore: 0,
    summary: `AI review unavailable: ${aiError}`,
    reasons: [aiError],
  };
  const panel = judged
    ? verifyDecision({ decision: judged.decision, requestBody: judged.requestBody, expectedNonce: judged.expectedNonce }, policy)
    : unavailablePanel(policy, NEAR_AI_MODEL, `AI review unavailable: ${aiError}`);

  const policyChecks = evaluatePolicy(inv, policy, { killSwitch: s.killSwitch, spentTodayUsd: spentTodayUsd() });
  await prefetchCounterparty(inv.payoutAddress, inv.chain);
  const fraudChecks = runFraudChecks(inv, fraudContext());
  const trusted = attestationTrusted(panel);
  const aiCheck: CheckResult = {
    id: "ai",
    label: "AI review",
    verdict: !panel.signature.valid ? "warn" : judgment.decision === "block" ? "block" : judgment.decision === "hold" ? "warn" : "allow",
    reason: !judged
      ? `The AI review could not run (${aiError}), so a human must look.`
      : !panel.signature.valid
        ? "The model's signature did not verify, so its opinion was ignored and a human must look."
        : `Model recommends "${judgment.decision}" (risk ${judgment.riskScore}/100): ${judgment.summary}`,
  };
  const checks = [...policyChecks, ...fraudChecks, aiCheck];
  const verdict = worst(checks);

  let status: PaymentStatus;
  let headline: string;
  let reason: string;
  const blocking = checks.filter((c) => c.verdict === "block");
  const warning = checks.filter((c) => c.verdict === "warn");

  if (verdict === "block") {
    status = "blocked";
    headline = `Blocked: ${blocking.filter((c) => c.id !== "ai").map((c) => shortReason(c)).join(" and ") || "the AI reviewer flagged it"}`;
    reason = blocking.map((c) => c.reason).join(" ");
  } else if (verdict === "warn") {
    status = "held";
    headline = `Held for a human: ${warning.map((c) => c.label.toLowerCase()).join(", ")}`;
    reason = warning.map((c) => c.reason).join(" ");
  } else if (needsApproval(inv, policy)) {
    status = "awaiting_approval";
    headline = "Needs a signer's approval";
    reason = `$${inv.amountUsd.toLocaleString()} is at or over the $${policy.approvalThresholdUsd.toLocaleString()} approval threshold.`;
  } else {
    status = "approved";
    headline = "Clear to pay";
    reason = "Every check passed.";
  }

  const now = new Date();
  const payment: Payment = {
    id: uid("pay"),
    invoice: inv,
    rail: "intents",
    status,
    headline,
    reason,
    confidentiality,
    checks,
    ai: judgment,
    verified: {
      ...panel,
      zkProof: null,
      pqSignature: { algo: "ML-DSA-65", publicKey: "", signature: "", valid: false },
    },
    createdAt: now.toISOString(),
    holdUntil: status === "held" ? new Date(now.getTime() + policy.holdWindowMinutes * 60_000).toISOString() : undefined,
    redactedInput: red.text,
    recordHash: "",
    prevHash: "",
  };
  if (!trusted) payment.verified.attestation.notes.push("Attestation is not fully verified; the AI result was treated as advisory only.");

  // Payout changed -> contact the vendor on a previously verified channel.
  if (blocking.some((c) => c.id === "payout_changed")) {
    const vendor = s.vendors.find((v) => v.name === inv.vendorName);
    payment.callback = await services.sendCallback(inv, vendor?.verifiedContact, "has new payout details that differ from our records", payment.id);
  }

  if (status === "approved") await release(payment);
  seal(payment);
  s.payments.unshift(payment);
  return payment;
}

const shortReason = (c: CheckResult) =>
  ({
    payout_changed: "payout address changed",
    injection: "instruction injection detected",
    lookalike: "lookalike vendor",
    duplicate: "duplicate invoice",
    po: "amount does not match the purchase order",
    blocklist: "payee is on the shared blocklist",
    counterparty: "risky receiver",
    kill: "kill switch is on",
    limit: "over the payment limit",
    daily: "over the daily limit",
    chain: "chain not permitted",
    asset: "asset not permitted",
  })[c.id] ?? c.label.toLowerCase();

/**
 * The only place a payment is released. Re-checks the hard rules at the moment of release, then asks NEAR
 * Intents for a real mainnet quote. Proofpay holds no treasury key: a signer sends the funds from their own
 * wallet to the deposit address, and settlement is confirmed from 1Click.
 */
export async function release(p: Payment): Promise<void> {
  const s = state();
  const policy = currentPolicy();
  const hard = evaluatePolicy(p.invoice, policy, {
    killSwitch: s.killSwitch,
    spentTodayUsd: spentTodayUsd() - (p.status === "ready_to_send" ? p.invoice.amountUsd : 0),
  }).filter((c) => c.verdict === "block");
  if (hard.length) {
    p.status = "blocked";
    p.headline = `Blocked at release: ${hard.map(shortReason).join(" and ")}`;
    p.reason = hard.map((c) => c.reason).join(" ");
    return;
  }
  try {
    p.quote = await services.quotePayout(p.invoice, p.confidentiality);
  } catch (e) {
    p.status = "held";
    p.headline = "Held: could not get a payout quote";
    p.reason = (e as Error).message;
    return;
  }
  p.status = "ready_to_send";
  p.headline = "Approved: send the funds";
  p.reason =
    `Send ${p.quote.amountIn} USDC on NEAR from the treasury to ${p.quote.depositAddress}${p.quote.deadline ? ` before ${p.quote.deadline}` : ""}. ` +
    `NEAR Intents then delivers ${p.quote.amountOut} ${p.invoice.asset} to the payee on ${p.invoice.chain}, confidentiality: ${p.confidentiality}. ` +
    "Proofpay does not hold a treasury key, so a signer sends this from their own wallet and then records the transaction.";
  const v = s.vendors.find((x) => x.name === p.invoice.vendorName);
  if (v && !v.paidInvoiceNumbers.includes(p.invoice.invoiceNumber)) v.paidInvoiceNumbers.push(p.invoice.invoiceNumber); // reserved against duplicates
}

const requireSigner = (signer: string) => {
  if (!SIGNER_NAMES.includes(signer)) throw new Error("Unknown signer");
};

export async function approve(id: string, signer: string): Promise<Payment> {
  requireSigner(signer);
  const p = mustFind(id);
  if (p.status !== "awaiting_approval" && p.status !== "held") throw new Error(`A ${p.status} payment cannot be approved`);
  p.approvedBy = signer;
  await release(p);
  seal(p);
  return p;
}

/** A signer reports the transaction they sent to the deposit address. */
export function recordSent(id: string, signer: string, txRef: string): Payment {
  requireSigner(signer);
  const p = mustFind(id);
  if (p.status !== "ready_to_send") throw new Error("This payment is not waiting for funds");
  if (!txRef.trim()) throw new Error("Paste the transaction hash you sent");
  p.txRef = txRef.trim();
  seal(p);
  return p;
}

const FINAL_FAIL = new Set(["REFUNDED", "FAILED"]);

/** Ask 1Click where the swap is. SUCCESS marks the payment paid; REFUNDED, FAILED or an expired quote releases the reservation. */
export async function checkSettlement(id: string): Promise<Payment> {
  const p = mustFind(id);
  if (p.status !== "ready_to_send" || !p.quote) throw new Error("This payment is not waiting for funds");
  const status = await services.swapStatus(p.quote.depositAddress, p.quote.depositMemo);
  p.settlement = { status, checkedAt: new Date().toISOString() };
  const v = state().vendors.find((x) => x.name === p.invoice.vendorName);
  if (status === "SUCCESS") {
    p.status = "paid";
    p.headline = "Paid";
    p.reason = `NEAR Intents confirmed delivery of ${p.quote.amountOut} ${p.invoice.asset} to the payee on ${p.invoice.chain}.`;
    if (v) {
      v.lastPaidAt = new Date().toISOString();
      if (p.callback?.status === "confirmed") v.payout = { chain: p.invoice.chain, asset: p.invoice.asset, address: p.invoice.payoutAddress };
    }
  } else if (FINAL_FAIL.has(status) || (status === "PENDING_DEPOSIT" && p.quote.deadline && new Date(p.quote.deadline) < new Date())) {
    p.status = "cancelled";
    p.headline = status === "REFUNDED" ? "Refunded: the swap did not complete" : status === "FAILED" ? "Failed: the swap did not complete" : "Quote expired before any deposit";
    p.reason = "Nothing was delivered to the payee. Submit the invoice again for a fresh quote.";
    if (v) v.paidInvoiceNumbers = v.paidInvoiceNumbers.filter((n) => n !== p.invoice.invoiceNumber);
  }
  seal(p);
  return p;
}

export function cancel(id: string): Payment {
  const p = mustFind(id);
  if (p.status === "paid") throw new Error("Already paid. Settled funds cannot be recalled.");
  if (p.status === "ready_to_send" && p.txRef) throw new Error("A transaction was already reported. Check settlement instead; sent funds cannot be recalled here.");
  const v = state().vendors.find((x) => x.name === p.invoice.vendorName);
  if (p.status === "ready_to_send" && v) v.paidInvoiceNumbers = v.paidInvoiceNumbers.filter((n) => n !== p.invoice.invoiceNumber);
  p.status = "cancelled";
  p.headline = "Cancelled";
  p.reason = "A signer cancelled this payment before any funds left.";
  seal(p);
  return p;
}

export function resolveCallback(id: string, answer: "yes" | "no"): Payment {
  const p = mustFind(id);
  if (!p.callback || p.callback.status !== "pending") throw new Error("No pending callback");
  p.callback.answer = answer === "yes" ? "YES, that was us." : "NO, that was not us.";
  p.callback.answeredAt = new Date().toISOString();
  if (answer === "no") {
    p.callback.status = "denied";
    p.status = "cancelled";
    p.headline = "Cancelled: vendor says it was not them";
    p.reason = "The vendor denied sending these details. Payment cancelled and the payout address added to the shared blocklist.";
    const entry = {
      id: uid("bl"),
      kind: "address" as const,
      value: p.invoice.payoutAddress,
      reason: "Payout address change denied by the vendor on a verified channel",
      evidenceHash: sha256(canonical({ invoice: p.invoice.invoiceNumber, text: p.redactedInput, callback: p.callback })),
      reportedBy: "this-treasury",
      at: new Date().toISOString(),
    };
    if (!state().blocklist.some((b) => b.value.toLowerCase() === entry.value.toLowerCase())) state().blocklist.unshift(entry);
  } else {
    p.callback.status = "confirmed";
    // A confirmed callback clears the address change only. Other blocks (injection etc.) stand.
    const stillBlocked = p.checks.some((c) => c.verdict === "block" && c.id !== "payout_changed" && c.id !== "ai");
    p.status = stillBlocked ? "blocked" : "awaiting_approval";
    p.headline = stillBlocked ? p.headline : "Vendor confirmed new details; needs a signer's approval";
    p.reason = stillBlocked ? p.reason : "The vendor confirmed the change on the verified channel. A signer still has to approve.";
  }
  seal(p);
  return p;
}

/** Hash-chain the record, sign it post-quantum, and keep an encrypted copy. Only hashes are meant to be public. */
export function seal(p: Payment): void {
  const s = state();
  const idx = s.payments.indexOf(p);
  const prev = (idx >= 0 ? s.payments[idx + 1] : s.payments[0])?.recordHash ?? "genesis";
  p.prevHash = prev;
  p.recordHash = "";
  const body = canonical({ ...p, recordHash: "" });
  p.recordHash = sha256(body);
  const pq = mlDsaSign(p.recordHash, pqSeed());
  p.verified.pqSignature = { algo: "ML-DSA-65", ...pq, valid: mlDsaVerify(pq.signature, p.recordHash, pq.publicKey) };
  s.sealed[p.id] = encrypt(JSON.stringify(p), dataKey());
}

export function mustFind(id: string): Payment {
  const p = state().payments.find((x) => x.id === id);
  if (!p) throw new Error("Payment not found");
  return p;
}

export function setKillSwitch(on: boolean) {
  state().killSwitch = on;
}

/** Proofpay Check: fraud engine as a service for any agent. */
export async function publicCheck(req: CheckRequest): Promise<CheckResponse> {
  await prefetchCounterparty(req.payoutAddress, req.chain);
  const checks = runPublicCheck(req, fraudContext());
  const verdict = worst(checks);
  state().checkLog.unshift({ at: new Date().toISOString(), verdict });
  return {
    verdict,
    checks,
    reasons: checks.filter((c) => c.verdict !== "allow").map((c) => c.reason),
    checkedAt: new Date().toISOString(),
  };
}

export function reportFraud(input: { kind: "address" | "domain"; value: string; reason: string; evidence: string; reportedBy: string }) {
  const exists = state().blocklist.some((b) => b.value.toLowerCase() === input.value.toLowerCase());
  if (exists) return state().blocklist.find((b) => b.value.toLowerCase() === input.value.toLowerCase())!;
  const e = {
    id: uid("bl"),
    kind: input.kind,
    value: input.value,
    reason: input.reason,
    evidenceHash: sha256(input.evidence),
    reportedBy: input.reportedBy,
    at: new Date().toISOString(),
  };
  state().blocklist.unshift(e);
  return e;
}

/** The agent buys an API call over x402, under the same policy and kill switch. */
export async function spendX402(url: string) {
  const s = state();
  const policy = currentPolicy();
  if (s.killSwitch) return { ok: false, note: "Kill switch is on. API spending is stopped." };
  const today = new Date().toISOString().slice(0, 10);
  const spent = s.x402Spend.filter((x) => x.at.startsWith(today)).reduce((a, b) => a + b.priceUsd, 0);
  const room = policy.x402DailyLimitUsd - spent;
  if (room <= 0) return { ok: false, note: `Daily API budget of $${policy.x402DailyLimitUsd} is used up.` };
  const r = await services.payX402(url, room);
  if (r.ok && r.priceUsd > 0) s.x402Spend.unshift({ at: new Date().toISOString(), url, priceUsd: r.priceUsd });
  return r;
}
