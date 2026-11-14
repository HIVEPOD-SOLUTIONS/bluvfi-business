import { isDemo } from "./tenant";
import { publicFetch } from "./net-guard";
import { cfg } from "./business";
import { canonical, mlDsaSign, mlDsaVerify, sha256, encrypt } from "./crypto";
import { NEAR_AI_MODEL } from "./config";
import { signerNames } from "./team";
import { demoDao, payoutWindowMs } from "./custody";
import { makeJob, proveInBackground, SYSTEM as ZK_SYSTEM, verifyZk, writeJob } from "./zk";
import { signPolicyCheck } from "./pqcheck";
import { runFraudChecks, runPublicCheck, worst } from "./fraud";
import type { Judged } from "./nearai";
import { attestationTrusted, computeFacts, unavailablePanel, verifyDecision } from "./nearai-core";
import { isRegisteredSigner } from "./aimodel";
import { businessGate } from "./kyb";
import { MIN_MINUTES_TO_PAY } from "./bills-time";
import { evaluatePolicy, needsApproval, privacyForPayment } from "./policy";
import { services } from "./services";
import { currentPolicy, dataKey, fraudContext, persistenceOn, pqSeed, pqSeeds, prefetchCounterparty, prefetchSanctions, refreshState, spentTodayUsd, state, withRecords } from "./store";
import { invoiceKey } from "./types";
import type { CheckRequest, CheckResponse, CheckResult, Confidentiality, Invoice, Payment, PaymentStatus } from "./types";

const uid = (p: string) => `${p}-${sha256(`${p}${Date.now()}${Math.random()}`).slice(0, 8)}`;

/**
 * The agent's whole job, in one place. Principle: the AI has judgment, never authority.
 * Final status = the strictest of (policy gate, fraud checks, AI recommendation).
 * The AI can tighten a result (pay -> hold) but can never loosen one.
 */
const invoiceInFlightElsewhere = (p: Payment) =>
  state().payments.some((o) => o.id !== p.id && (o.status === "paid" || o.status === "ready_to_send" || o.status === "proposed") && o.invoice.vendorName === p.invoice.vendorName && invoiceKey(o.invoice.invoiceNumber) === invoiceKey(p.invoice.invoiceNumber));

/** A "pay" with a risk score at or above this is held for a human. */
const AI_HOLD_RISK = 70;

export async function processInvoice(inv: Invoice, confidentiality: Confidentiality = "basic", extra: Pick<Payment, "bill"> = {}): Promise<Payment> {
  // Amounts are in cents from here on: $4,999.9999 is $5,000.00, so it cannot slip under a limit and be paid as more.
  inv = { ...inv, amountUsd: Math.round(inv.amountUsd * 100) / 100 };
  // The slow outside calls (redaction, the private AI review, on-chain and sanctions lookups) run before the business's records
  // are locked, so a review that takes a minute does not make every signer's click wait. Only deciding and saving take the lock.
  refreshState();
  const red = await services.redact(inv.text);
  const facts = computeFacts(inv, state().vendors, state().purchaseOrders);
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
    ? verifyDecision({ decision: judged.decision, requestBody: judged.requestBody, expectedNonce: judged.expectedNonce }, currentPolicy())
    : unavailablePanel(currentPolicy(), NEAR_AI_MODEL, `AI review unavailable: ${aiError}`);
  // Was this decision signed by a key vetted at setup (lib/aimodel.ts)? Its own attestation was checked either way.
  if (judged) panel.attestation.registered = isRegisteredSigner(judged.decision.signingAddress);
  if (judged?.decision.attestation.structured === false) panel.attestation.notes.push("NEAR AI did not take the decision schema as structured output for this model, so the reply was checked against it here instead.");

  await prefetchCounterparty(inv.payoutAddress, inv.chain);
  await prefetchSanctions(inv.payoutAddress, inv.vendorName);

  return withRecords(async () => {
  const s = state();
  const policy = currentPolicy();
  const policyCtx = { killSwitch: s.killSwitch, spentTodayUsd: spentTodayUsd(), businessGate: businessGate(inv.amountUsd, privacyForPayment(confidentiality, inv, policy).level, policy) };
  const policyChecks = evaluatePolicy(inv, policy, policyCtx);
  // Privacy is optional, but the policy can set a floor (for investors, institutions and others who need it).
  // A provider's order only lasts so long: a payment that cannot be sent in time is refused now, not sent late.
  if (inv.expiresAt) {
    const left = (Date.parse(inv.expiresAt) - Date.now()) / 60_000;
    policyChecks.push({
      id: "provider_expiry", label: "Provider's price", verdict: left >= MIN_MINUTES_TO_PAY ? "allow" : "block",
      reason: left >= MIN_MINUTES_TO_PAY ? `${inv.vendorName} holds this order for about ${Math.floor(left)} more minutes, so it has to be approved and sent within that time.` : `${inv.vendorName}'s price for this order has run out, or is too close to running out to be sent. Order again.`,
    });
  }
  const priv = privacyForPayment(confidentiality, inv, policy);
  const conf = priv.level;
  if (conf !== confidentiality) {
    policyChecks.push({ id: "privacy", label: "Privacy rules", verdict: "allow", reason: `Confidentiality raised from ${confidentiality} to ${conf} by policy v${policy.version}: ${priv.why.join("; ")}.` });
  }
  const fraudChecks = runFraudChecks(inv, fraudContext());
  const trusted = attestationTrusted(panel);
  // A "pay" only counts from a review whose hardware evidence verified in full (TDX, NVIDIA, the key binding, our nonce):
  // a valid signature alone proves nothing, since the signing key comes from the same report. Demo replays never claim
  // hardware attestation, so demo mode is exempt. A high risk score holds a "pay" too: the AI may only make it stricter.
  const unproven = !!judged && panel.signature.valid && !trusted && !isDemo();
  const risky = !!judged && judgment.decision === "pay" && judgment.riskScore >= AI_HOLD_RISK;
  const aiCheck: CheckResult = {
    id: "ai",
    label: "AI review",
    verdict: !panel.signature.valid || unproven ? "warn" : judgment.decision === "block" ? "block" : judgment.decision === "hold" || risky ? "warn" : "allow",
    reason: !judged
      ? `The AI review could not run (${aiError}), so a human must look.`
      : !panel.signature.valid
        ? "The model's signature did not verify, so its opinion was ignored and a human must look."
        : unproven
          ? `The model's hardware attestation did not verify in full, so its "${judgment.decision}" was not relied on and a human must look.`
          : risky
            ? `Model says "pay" but rates the risk ${judgment.riskScore}/100, so a human must look: ${judgment.summary}`
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
    confidentiality: conf,
    checks,
    ai: judgment,
    verified: {
      ...panel,
      zkProof: null,
      pqSignature: { algo: "ML-DSA-65", publicKey: "", signature: "", valid: false },
    },
    ...extra, // what the caller already knows (a bill's order), so it is inside the signed record from the start
    createdAt: now.toISOString(),
    holdUntil: status === "held" ? new Date(now.getTime() + policy.holdWindowMinutes * 60_000).toISOString() : undefined,
    redactedInput: red.text,
    redactedBy: red.source,
    recordHash: "",
    prevHash: "",
  };
  if (red.note) payment.verified.attestation.notes.push(red.note);
  // The same policy check as a zero-knowledge statement (lib/zk.ts), proved by o1js in a background process.
  payment.zkJob = makeJob(payment.id, inv, policy, policyCtx);
  payment.verified.zkProof = { system: ZK_SYSTEM, status: "pending", note: "Statement written; the proof is being made in the background." };
  // The same statement and result, signed with two post-quantum schemes (lattice and hash-based). Anyone can re-run it.
  payment.verified.policyCheckPq = signPolicyCheck(payment.id, payment.zkJob, pqSeeds());
  if (persistenceOn()) {
    writeJob(payment.id, payment.zkJob);
    proveInBackground();
  }
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
  });
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
    business_kyb: "your business is not verified",
    provider_expiry: "the provider's price ran out",
    sanctions: "payee is on a sanctions list",
    vendor_kyb: "vendor failed verification",
    limit: "over the payment limit",
    daily: "over the daily limit",
    chain: "chain not permitted",
    asset: "asset not permitted",
  })[c.id] ?? c.label.toLowerCase();

/**
 * The only place a payment is released. Re-checks the hard rules at the moment of release, then asks NEAR
 * Intents for a real mainnet quote. Bluvfi Business holds no treasury key: a signer sends the funds from their own
 * wallet to the deposit address, and settlement is confirmed from 1Click.
 */
export async function release(p: Payment): Promise<void> {
  const s = state();
  const policy = currentPolicy();
  const hard = evaluatePolicy(p.invoice, policy, {
    killSwitch: s.killSwitch,
    spentTodayUsd: spentTodayUsd() - (p.status === "ready_to_send" ? p.invoice.amountUsd : 0),
    businessGate: businessGate(p.invoice.amountUsd, p.confidentiality, policy),
  }).filter((c) => c.verdict === "block");
  // Another payment of the same invoice may have been approved since this one arrived.
  if (invoiceInFlightElsewhere(p)) hard.push({ id: "duplicate", label: "Duplicate invoice", verdict: "block", reason: `Invoice ${p.invoice.invoiceNumber} is already in another payment that is paid or on its way.` });
  if (hard.length) {
    p.status = "blocked";
    p.headline = `Blocked at release: ${hard.map(shortReason).join(" and ")}`;
    p.reason = hard.map((c) => c.reason).join(" ");
    return;
  }
  // The list may have changed since intake: screen the payee again at the moment money would move.
  await prefetchSanctions(p.invoice.payoutAddress, p.invoice.vendorName);
  const listed = fraudContext().sanctions?.(p.invoice.payoutAddress, p.invoice.vendorName)?.hits.find((h) => h.kind === "address");
  if (listed) {
    p.status = "blocked";
    p.headline = "Blocked at release: payee is on a sanctions list";
    p.reason = `The payout address is on the US OFAC sanctions list: ${listed.detail}.`;
    return;
  }
  try {
    p.confidentiality = privacyForPayment(p.confidentiality, p.invoice, currentPolicy()).level; // the rules may have been tightened since intake
    let window = await payoutWindowMs();
    // A bill's order lasts minutes, not days: the quote must end before it does, and there must be time left to send.
    if (p.invoice.expiresAt) {
      const left = Date.parse(p.invoice.expiresAt) - Date.now();
      if (left < MIN_MINUTES_TO_PAY * 60_000) {
        p.status = "cancelled";
        p.headline = "Cancelled: the provider's price ran out before this could be sent";
        p.reason = `${p.invoice.vendorName} only holds an order for a short time. Nothing was sent. Order again.`;
        return;
      }
      window = Math.min(window, left - 60_000);
    }
    // A confidential treasury quotes from its shielded balance; everyone else quotes a public deposit address.
    p.quote = cfg().CONFIDENTIAL ? await services.quoteConfidential(p.invoice, window) : await services.quotePayout(p.invoice, p.confidentiality, window);
  } catch (e) {
    p.status = "held";
    p.headline = "Held: could not get a payout quote";
    p.reason = (e as Error).message;
    return;
  }
  if (p.quote.source === "1click-dry") {
    // Dry-run mode: a real 1Click price, but no deposit address, so nothing can be sent.
    p.status = "approved";
    p.headline = "Approved (dry run): nothing is sent";
    p.reason = `1Click quoted ${p.quote.amountIn} USDC on NEAR for ${p.quote.amountOut} ${p.invoice.asset} on ${p.invoice.chain}. ONECLICK_DRY is on, so there is no deposit address and no payout.`;
    return;
  }
  const v = s.vendors.find((x) => x.name === p.invoice.vendorName);
  if (cfg().CUSTODY !== "manual") {
    // The custodian holds the funds. The agent can only hand it this payout; the DAO council or OutLayer's policy decides.
    try {
      p.custody = await services.submitPayout(p);
    } catch (e) {
      const msg = (e as Error).message;
      const refused = /policy refused|custody check failed/i.test(msg);
      p.status = refused ? "blocked" : "held";
      p.headline = refused ? "Blocked by the custodian" : "Held: the custodian could not take the payout";
      p.reason = msg;
      return;
    }
    if (v && !v.paidInvoiceNumbers.includes(p.invoice.invoiceNumber)) v.paidInvoiceNumbers.push(p.invoice.invoiceNumber); // reserved against duplicates
    p.committedAt = new Date().toISOString();
    applyCustody(p);
    return;
  }
  p.status = "ready_to_send";
  p.headline = "Approved: send the funds";
  p.reason =
    `Send ${p.quote.amountIn} USDC on NEAR from the treasury to ${p.quote.depositAddress}${p.quote.deadline ? ` before ${p.quote.deadline}` : ""}. ` +
    `${p.invoice.allocation ? `NEAR Intents then puts about ${p.quote.amountOut} ${p.invoice.allocation.symbol} into the treasury's own account` : `NEAR Intents then delivers ${p.quote.amountOut} ${p.invoice.asset} to the payee on ${p.invoice.chain}`}, confidentiality: ${p.confidentiality}. ` +
    "Bluvfi Business does not hold a treasury key, so a signer sends this from their own wallet and then records the transaction.";
  p.committedAt = new Date().toISOString();
  if (v && !v.paidInvoiceNumbers.includes(p.invoice.invoiceNumber)) v.paidInvoiceNumbers.push(p.invoice.invoiceNumber); // reserved against duplicates
}

/** Move a payment along with what the custodian reports. Executed means the USDC left for the 1Click deposit address. */
function applyCustody(p: Payment) {
  const c = p.custody!;
  const where = c.backend === "sputnik" ? `DAO proposal #${c.ref}` : `OutLayer request ${c.ref}`;
  if (c.state === "executed") {
    p.status = "ready_to_send";
    p.txRef = c.txHash ?? `${c.backend}:${c.ref}`;
    p.headline = "Sent by the treasury: waiting for NEAR Intents to deliver";
    p.reason = `${c.route ? `${c.route} ` : ""}${c.detail} ${p.invoice.allocation ? `NEAR Intents then puts about ${p.quote?.amountOut} ${p.invoice.allocation.symbol} into the treasury's own account.` : `NEAR Intents then delivers ${p.quote?.amountOut} ${p.invoice.asset} to the payee on ${p.invoice.chain}.`}`;
  } else if (c.state === "pending") {
    p.status = "proposed";
    p.headline = c.backend === "sputnik" ? `Proposed to the treasury DAO (#${c.ref}): needs council votes` : "Submitted to the OutLayer wallet: waiting for its approvers";
    p.reason = `${c.route ? `${c.route} ` : ""}${c.detail} The agent cannot move funds itself; ${where} only executes once the people who control the treasury approve it.`;
  } else if (c.state === "failed" && c.backend === "sputnik") {
    // A Sputnik proposal whose transfer failed may be run again later, and then it pays: keep the invoice reserved and keep
    // watching it, and never propose it a second time.
    p.status = "held";
    p.headline = `Held: DAO proposal #${c.ref} was approved but its transfer failed`;
    p.reason = `${c.detail} It could still be run again, so this payment keeps its invoice and is not proposed a second time. Fix the cause (for example the DAO's USDC balance) and ask the council to run it again in Trezu, or have it removed.`;
  } else {
    const v = state().vendors.find((x) => x.name === p.invoice.vendorName);
    if (v) v.paidInvoiceNumbers = v.paidInvoiceNumbers.filter((n) => n !== p.invoice.invoiceNumber);
    p.status = c.state === "rejected" ? "cancelled" : "held";
    p.headline = c.state === "rejected" ? "Rejected by the treasury" : "Held: the treasury could not execute the payout";
    p.reason = c.detail;
  }
}

const requireSigner = (signer: string) => {
  if (!signerNames().includes(signer)) throw new Error("Unknown signer");
};

export async function approve(id: string, signer: string): Promise<Payment> {
  requireSigner(signer);
  const p = mustFind(id);
  if (p.status !== "awaiting_approval" && p.status !== "held") throw new Error(`A ${p.status} payment cannot be approved`);
  // The hold window is policy: a held payment waits it out, cancellable, before any signer can release it.
  if (p.status === "held" && p.holdUntil && new Date(p.holdUntil) > new Date()) {
    throw new Error(`This payment is in its hold window until ${new Date(p.holdUntil).toLocaleString()}. It can be cancelled now, and approved after that.`);
  }
  if (proposalCouldPay(p)) throw new Error(`DAO proposal #${p.custody!.ref} for this payment could still execute, so it is not proposed a second time. Have it removed in Trezu first.`);
  // Someone who typed in the vendor's "yes, that was us" by hand cannot also be the one who approves the payment.
  if (p.callback?.recordedBy === signer && signerNames().length > 1) throw new Error("You recorded the vendor's confirmation, so a different signer must approve this payment");
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
  // Let 1Click know, so it verifies the deposit now. Best effort: the status check settles the payment either way.
  if (p.quote) void services.submitDeposit(p.txRef, p.quote.depositAddress, p.quote.depositMemo).catch(() => false);
  seal(p);
  return p;
}

const FINAL_FAIL = new Set(["REFUNDED", "FAILED"]);

/** Ask 1Click where the swap is. SUCCESS marks the payment paid; REFUNDED, FAILED or an expired quote releases the reservation. */
/** A payment whose DAO proposal could still execute: open, or failed and so perhaps run again. */
export const proposalCouldPay = (p: Payment) => !!p.custody && (p.status === "proposed" || (p.status === "held" && p.custody.backend === "sputnik" && p.custody.state === "failed"));

export async function checkSettlement(id: string): Promise<Payment> {
  const p = mustFind(id);
  if (proposalCouldPay(p)) {
    p.custody = await services.refreshPayout(p.custody!);
    applyCustody(p);
    if ((p.status as PaymentStatus) !== "ready_to_send") {
      if (p.status !== "proposed") {
        seal(p);
        return p;
      }
      // Still waiting on votes. If the deposit address has stopped working, funds sent now could be lost: stop it here.
      const dead = p.status === "proposed" && p.quote ? p.quote.timeWhenInactive : undefined;
      if (dead && new Date(dead) < new Date()) {
        // The proposal can still pass, so the payment stays open and keeps being checked, and its invoice stays reserved:
        // freeing it now would let the same invoice be proposed again while this one could still execute.
        p.headline = `Reject this payout: its deposit address expired before it was approved`;
        p.reason = `The 1Click deposit address stopped working at ${dead}, and funds sent to it now could be lost. ${p.custody!.backend === "sputnik" ? `Vote Reject or Remove on DAO proposal #${p.custody!.ref}` : "Reject the pending request in OutLayer"} so it can never execute. Once it is rejected this payment shows as rejected, and the invoice can be submitted again for a fresh quote.`;
      }
      seal(p);
      return p;
    }
  }
  if (p.status !== "ready_to_send" || !p.quote) throw new Error("This payment is not waiting for funds");
  const status = p.quote.confidential ? await services.confidentialStatus(p.quote.depositAddress) : await services.swapStatus(p.quote.depositAddress, p.quote.depositMemo);
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
  if (p.status === "ready_to_send" && p.custody) throw new Error("The treasury already sent this. Check settlement instead; sent funds cannot be recalled here.");
  // While the custodian can still execute it, cancelling here would free the invoice for a second payment that could
  // execute too. The council rejects it there; this payment then shows as rejected on its own.
  if (proposalCouldPay(p)) {
    throw new Error(p.custody!.state === "failed"
      ? `DAO proposal #${p.custody!.ref} failed but could be run again, and then it pays. Have it removed in Trezu first.`
      : p.custody!.backend === "sputnik"
      ? `DAO proposal #${p.custody!.ref} is still open and could still pay. Vote Reject or Remove on it in Trezu; this payment then shows as rejected on its own.`
      : `OutLayer request ${p.custody!.ref} is still open and could still pay. Reject it in OutLayer; this payment then shows as rejected on its own.`);
  }
  const v = state().vendors.find((x) => x.name === p.invoice.vendorName);
  if ((p.status === "ready_to_send" || p.status === "proposed") && v) v.paidInvoiceNumbers = v.paidInvoiceNumbers.filter((n) => n !== p.invoice.invoiceNumber);
  p.status = "cancelled";
  p.headline = "Cancelled";
  p.reason = "A signer cancelled this payment before any funds left.";
  seal(p);
  return p;
}

export function resolveCallback(id: string, answer: "yes" | "no", how?: string, recordedBy?: string): Payment {
  const p = mustFind(id);
  if (!p.callback || p.callback.status !== "pending") throw new Error("No pending callback");
  // A late answer must not bring back a payment that was cancelled or has moved on since.
  if (p.status !== "blocked" && p.status !== "held") throw new Error(`This payment is ${p.status} now, so the vendor's answer no longer changes it`);
  if (recordedBy) p.callback.recordedBy = recordedBy;
  p.callback.answer = (answer === "yes" ? "YES, that was us." : "NO, that was not us.") + (how ? ` (${how})` : "");
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
    // A confirmed callback clears the address change only. Other blocks (injection, the AI's own block, etc.) stand.
    const stillBlocked = p.checks.some((c) => c.verdict === "block" && c.id !== "payout_changed");
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

export function setKillSwitch(on: boolean, by = "unknown") {
  state().killLog.unshift({ at: new Date().toISOString(), by, on });
  state().killSwitch = on;
}

/** Bluvfi Business Check: fraud engine as a service for any agent. */
export async function publicCheck(req: CheckRequest): Promise<CheckResponse> {
  await prefetchCounterparty(req.payoutAddress, req.chain);
  await prefetchSanctions(req.payoutAddress, req.vendorName ?? "");
  const checks = runPublicCheck(req, fraudContext());
  const verdict = worst(checks);
  state().checkLog.unshift({ at: new Date().toISOString(), verdict });
  if (state().checkLog.length > 1000) state().checkLog.length = 1000; // public and anonymous: never grows without bound
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
  // The URL came from a person: every connection is checked at connect time (lib/net-guard.ts), DNS rebinding included.
  const r = await services.payX402(url, room, {}, (u, init) => publicFetch(u, init));
  if (r.ok && r.priceUsd > 0) s.x402Spend.unshift({ at: new Date().toISOString(), url, priceUsd: r.priceUsd });
  return r;
}

/**
 * Demo mode only: a council member votes on the simulated DAO. On mainnet votes are real transactions,
 * cast in Trezu or sent gasless from the payment page through the relayer (lib/custody.ts relayVote).
 */
export async function demoTreasuryVote(id: string, member: string, approve: boolean): Promise<Payment> {
  if (!isDemo()) throw new Error("Votes go to the DAO itself on mainnet");
  requireSigner(member);
  const p = mustFind(id);
  if (p.status !== "proposed" || p.custody?.backend !== "sputnik") throw new Error("This payment is not waiting for a DAO vote");
  demoDao().vote(Number(p.custody.ref), member, approve ? "VoteApprove" : "VoteReject");
  return checkSettlement(id);
}

/**
 * Pick up the zero-knowledge proof of a payment's policy check once the background prover has made it, and verify
 * it here (o1js, plus statement and output checked against the payment). Called when a payment is viewed and by
 * `npm run zk:verify`.
 */
export async function refreshZk(p: Payment): Promise<Payment> {
  if (!p.zkJob || p.verified.zkProof?.status === "verified") return p;
  const before = JSON.stringify(p.verified.zkProof);
  const proof = await verifyZk(p.id, p.zkJob);
  if (JSON.stringify(proof) === before) return p;
  // Called from a page view: save under the records lock, onto the latest copy of the payment (another instance may have
  // changed it while the proof was being checked), never a stale snapshot.
  return withRecords(() => {
    const fresh = state().payments.find((x) => x.id === p.id);
    if (!fresh) return p;
    fresh.verified.zkProof = proof;
    seal(fresh);
    return fresh;
  });
}
