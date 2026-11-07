import { canonical, sha256 } from "./crypto";
import { privacyFor, RANK as PRIVACY_RANK } from "./privacy";
import type { CheckResult, Confidentiality, Invoice, Policy, PolicyProposal } from "./types";

/**
 * Policy gate. Deterministic, no AI in the loop: whatever the model says, this decides
 * whether money may move. There is no smart contract in this build; the gate runs in the
 * server process and is the only code path that can release a payment.
 */
export function hashPolicy(p: Omit<Policy, "hash">): string {
  return sha256(canonical(p));
}

export function makePolicy(
  version: number,
  body: PolicyProposal["changes"],
  createdAt = new Date().toISOString()
): Policy {
  const partial = { version, createdAt, ...body };
  return { ...partial, hash: hashPolicy(partial) };
}

/**
 * Re-checks the whole policy history: versions run 1..n with no gaps, and every stored hash is the hash of
 * that version's own contents. A version edited after the fact no longer matches its hash.
 */
export function verifyPolicyHistory(policies: Policy[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  policies.forEach((p, i) => {
    if (p.version !== i + 1) problems.push(`Version ${p.version} is at position ${i + 1}.`);
    const { hash, ...rest } = p;
    if (hashPolicy(rest) !== hash) problems.push(`Version ${p.version} does not match its hash.`);
  });
  return { ok: problems.length === 0, problems };
}

export const DEFAULT_POLICY_BODY: PolicyProposal["changes"] = {
  perPaymentLimitUsd: 10_000,
  dailyLimitUsd: 15_000,
  approvalThresholdUsd: 5_000,
  holdWindowMinutes: 30,
  allowedChains: ["near", "eth", "arb", "base", "sol"],
  allowedAssets: ["USDC", "USDT"],
  vendorAllowlist: [],
  x402DailyLimitUsd: 5,
  privacyFloor: "public",
  requirePostQuantumKeys: false,
  // Tiered verification: most payments ask nobody for anything; the vendor verifies from the approval threshold up.
  verifyVendorsFromUsd: 5_000,
  verifyNewVendors: false,
  verifyForPrivacy: false,
  acceptPassportProof: true,
  // One-time cards: at most this much a day on cards. Each card is also under the per-payment limit and, from the approval threshold, needs signers.
  cardDailyLimitUsd: 500,
};

/** The confidentiality a payment actually gets: what was asked for, raised to the policy's privacy floor. */
export const withPrivacyFloor = (asked: Confidentiality, p: Policy): Confidentiality => {
  const floor = p.privacyFloor ?? "public";
  return PRIVACY_RANK[asked] >= PRIVACY_RANK[floor] ? asked : floor;
};

/** The confidentiality this payment gets under every privacy rule in the policy (floor, amount tiers, named vendors), and why. */
export const privacyForPayment = (asked: Confidentiality, inv: Pick<Invoice, "vendorName" | "amountUsd">, p: Policy) => privacyFor(asked, p, inv.vendorName, inv.amountUsd);

export interface PolicyContext {
  killSwitch: boolean;
  spentTodayUsd: number;
  /** Why this business may not pay yet (its own verification is not approved); missing means it may. */
  businessGate?: string;
}

export function evaluatePolicy(inv: Invoice, policy: Policy, ctx: PolicyContext): CheckResult[] {
  const r: CheckResult[] = [];
  const add = (
    id: string,
    label: string,
    ok: boolean,
    okMsg: string,
    badMsg: string,
    bad: "warn" | "block" = "block"
  ) => r.push({ id, label, verdict: ok ? "allow" : bad, reason: ok ? okMsg : badMsg });

  const usd = (n: number) => `$${n.toLocaleString()}`;
  if (ctx.businessGate) r.push({ id: "business_kyb", label: "Business verification", verdict: "block", reason: ctx.businessGate });
  add("kill", "Kill switch", !ctx.killSwitch, "Payments are enabled.", "Kill switch is on. All payments are stopped.");
  add(
    "limit",
    "Per-payment limit",
    inv.amountUsd <= policy.perPaymentLimitUsd,
    `${usd(inv.amountUsd)} is within the ${usd(policy.perPaymentLimitUsd)} limit.`,
    `${usd(inv.amountUsd)} is over the ${usd(policy.perPaymentLimitUsd)} per-payment limit.`
  );
  add(
    "daily",
    "Daily limit",
    ctx.spentTodayUsd + inv.amountUsd <= policy.dailyLimitUsd,
    "Within today's spending limit.",
    `Paying this would take today's total to ${usd(ctx.spentTodayUsd + inv.amountUsd)}, over the ${usd(policy.dailyLimitUsd)} daily limit.`
  );
  add(
    "chain",
    "Allowed chain",
    policy.allowedChains.includes(inv.chain),
    `Paying on ${inv.chain} is permitted.`,
    `Paying on ${inv.chain} is not permitted by policy v${policy.version}.`
  );
  add(
    "asset",
    "Allowed asset",
    policy.allowedAssets.includes(inv.asset),
    `${inv.asset} is permitted.`,
    `${inv.asset} is not permitted by policy v${policy.version}.`
  );
  if (inv.allocation) {
    // An investment pays no vendor: the money goes back into the treasury as another coin. The council's investing rules decide it.
    const sym = inv.allocation.symbol;
    const allowed = policy.investAssets?.includes(sym) && inv.amountUsd <= (policy.investMaxUsd ?? 0);
    add(
      "invest", "Investing", !!allowed,
      `Policy v${policy.version} allows putting up to ${usd(policy.investMaxUsd ?? 0)} into ${sym}.`,
      !policy.investAssets?.length ? "The council has not allowed investing: no coins are on the list." : !policy.investAssets.includes(sym) ? `The council has not allowed ${sym}. Allowed: ${policy.investAssets.join(", ")}.` : `${usd(inv.amountUsd)} is over the ${usd(policy.investMaxUsd ?? 0)} the council allows for one investment.`
    );
  } else {
    add(
      "allowlist",
      "Vendor allowlist",
      policy.vendorAllowlist.includes(inv.vendorName),
      "Vendor is on the allowlist.",
      "Vendor is not on the allowlist. A signer must add it first.",
      "warn"
    );
  }
  return r;
}

export const needsApproval = (inv: Invoice, p: Policy) => inv.amountUsd >= p.approvalThresholdUsd;
