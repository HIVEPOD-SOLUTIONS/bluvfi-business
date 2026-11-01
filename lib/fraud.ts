import type { BlocklistEntry, CheckRequest, CheckResult, Invoice, PurchaseOrder, Vendor } from "./types";

export interface CounterpartySignals {
  ageDays: number | null;
  isContract: boolean | null;
  codeChangedRecently: boolean | null;
  priorInteractions: number;
  source: "near-rpc" | "unknown";
}

export interface FraudContext {
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  blocklist: BlocklistEntry[];
  counterparty: (address: string) => CounterpartySignals;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Fold look-alike characters, e.g. "rn" for "m", "1" for "l". */
const fold = (s: string) => norm(s).replace(/rn/g, "m").replace(/vv/g, "w").replace(/1/g, "l").replace(/0/g, "o");

const INJECTION_PATTERNS: [RegExp, string][] = [
  [/ignore (all |any )?(your |the |previous |prior )*(instructions|rules|polic(y|ies))/i, "tells the reader to ignore its rules"],
  [/(skip|bypass|disable|turn off) (the )?(fraud|security|policy|safety|verification)/i, "asks to skip fraud or policy checks"],
  [/(you are|you're) (now )?(in )?(admin|developer|system|god) mode/i, "claims a privileged mode"],
  [/^\s*system\s*:/im, "pretends to be a system message"],
  [/(approve|pay|send) (this )?(invoice |payment )?(immediately|now|without)/i, "pressures for immediate payment"],
  [/do not (tell|alert|notify|contact) (the )?(user|human|signer|finance)/i, "asks the agent to hide something from humans"],
  [/[​‌⁠﻿]/, "contains invisible characters"],
];

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

export function runFraudChecks(inv: Invoice, ctx: FraudContext): CheckResult[] {
  const out: CheckResult[] = [];
  const vendor = ctx.vendors.find((v) => v.name === inv.vendorName);
  const usd = (n: number) => `$${n.toLocaleString()}`;

  // 1. Payout details changed since the vendor's last payment.
  if (vendor) {
    const p = vendor.payout;
    const same = p.address.toLowerCase() === inv.payoutAddress.toLowerCase() && p.chain === inv.chain;
    out.push({
      id: "payout_changed",
      label: "Payout details",
      verdict: same ? "allow" : "block",
      reason: same
        ? "Payout address matches the last verified payment."
        : `Payout address changed from ${p.address} (${p.chain}) to ${inv.payoutAddress} (${inv.chain}).`,
    });
  } else {
    out.push({ id: "payout_changed", label: "Payout details", verdict: "warn", reason: "First payment to this vendor, so there is nothing to compare against." });
  }

  // 2. Duplicate invoice.
  const dup = ctx.vendors.some((v) => v.name === inv.vendorName && v.paidInvoiceNumbers.includes(inv.invoiceNumber));
  out.push({
    id: "duplicate",
    label: "Duplicate invoice",
    verdict: dup ? "block" : "allow",
    reason: dup ? `Invoice ${inv.invoiceNumber} has already been paid.` : "Invoice number has not been paid before.",
  });

  // 3. Amount vs purchase order.
  const po = ctx.purchaseOrders.find((p) => p.po === inv.poNumber);
  out.push(
    !po
      ? { id: "po", label: "Purchase order", verdict: "warn", reason: `No purchase order found for ${inv.poNumber}.` }
      : po.vendorName !== inv.vendorName
        ? { id: "po", label: "Purchase order", verdict: "block", reason: `${inv.poNumber} was raised for ${po.vendorName}, not ${inv.vendorName}.` }
        : Math.abs(po.amountUsd - inv.amountUsd) > 0.01
          ? { id: "po", label: "Purchase order", verdict: "block", reason: `Invoice is ${usd(inv.amountUsd)} but ${po.po} was for ${usd(po.amountUsd)}.` }
          : { id: "po", label: "Purchase order", verdict: "allow", reason: `Matches ${po.po} at ${usd(po.amountUsd)}.` }
  );

  // 4. Lookalike vendor name or domain.
  const others = ctx.vendors.filter((v) => v.name !== inv.vendorName);
  const lookalike = others.find((v) => {
    const nameClose = fold(v.name) === fold(inv.vendorName) || levenshtein(norm(v.name), norm(inv.vendorName)) <= 2;
    const domClose = v.domain !== inv.vendorDomain && levenshtein(norm(v.domain), norm(inv.vendorDomain)) <= 2;
    return nameClose || domClose;
  });
  const domainMismatch = vendor && vendor.domain !== inv.vendorDomain;
  out.push({
    id: "lookalike",
    label: "Lookalike vendor",
    verdict: lookalike || domainMismatch ? "block" : "allow",
    reason: lookalike
      ? `"${inv.vendorName}" / ${inv.vendorDomain} is suspiciously close to known vendor ${lookalike.name} (${lookalike.domain}).`
      : domainMismatch
        ? `Invoice domain ${inv.vendorDomain} differs from the vendor's known domain ${vendor!.domain}.`
        : "No lookalike of a known vendor name or domain.",
  });

  // 5. Counterparty signals.
  const s = ctx.counterparty(inv.payoutAddress);
  const issues: string[] = [];
  if (s.ageDays !== null && s.ageDays < 14) issues.push(`account is only ${s.ageDays} days old`);
  if (s.codeChangedRecently) issues.push("its contract code changed recently");
  if (s.priorInteractions === 0 && vendor) issues.push("this treasury has never paid it");
  out.push({
    id: "counterparty",
    label: "Counterparty signals",
    verdict: issues.length >= 2 ? "block" : issues.length === 1 ? "warn" : "allow",
    reason: issues.length
      ? `Receiver: ${issues.join("; ")}.`
      : s.source === "unknown"
        ? "No on-chain history available for this address."
        : `Receiver ${s.ageDays === null ? "exists on-chain (age unknown)" : `is ${s.ageDays} days old`}; ${s.priorInteractions} prior payment${s.priorInteractions === 1 ? "" : "s"} from this treasury.`,
  });

  // 6. Shared blocklist.
  const listed = ctx.blocklist.find(
    (b) =>
      (b.kind === "address" && b.value.toLowerCase() === inv.payoutAddress.toLowerCase()) ||
      (b.kind === "domain" && b.value.toLowerCase() === inv.vendorDomain.toLowerCase())
  );
  out.push({
    id: "blocklist",
    label: "Shared blocklist",
    verdict: listed ? "block" : "allow",
    reason: listed
      ? `Reported by ${listed.reportedBy}: ${listed.reason} (evidence ${listed.evidenceHash.slice(0, 10)}…).`
      : "Not on the shared blocklist.",
  });

  // 7. Prompt injection.
  const inj = detectInjection(inv.text);
  out.push({
    id: "injection",
    label: "Instruction injection",
    verdict: inj.length ? "block" : "allow",
    reason: inj.length
      ? `Invoice text ${inj.join(", ")}. The model is never given authority, so this cannot succeed, but it is a strong fraud signal.`
      : "No hidden instructions found in the invoice text.",
  });

  return out;
}

/** Bluvfi Business Check: the same engine for any agent asking about a payee. */
export function runPublicCheck(req: CheckRequest, ctx: FraudContext): CheckResult[] {
  const inv: Invoice = {
    id: "check",
    vendorName: req.vendorName ?? "(unknown)",
    vendorDomain: req.vendorDomain ?? "",
    vendorContact: { channel: "email", handle: "" },
    invoiceNumber: "-",
    poNumber: "-",
    amountUsd: req.amountUsd ?? 0,
    asset: "USDC",
    chain: req.chain ?? "near",
    payoutAddress: req.payoutAddress,
    text: req.invoiceText ?? "",
    receivedAt: new Date().toISOString(),
  };
  const skip = new Set(["duplicate", "po"]);
  return runFraudChecks(inv, ctx).filter((c) => !skip.has(c.id));
}

export const worst = (cs: { verdict: "allow" | "warn" | "block" }[]): "allow" | "warn" | "block" =>
  cs.some((c) => c.verdict === "block") ? "block" : cs.some((c) => c.verdict === "warn") ? "warn" : "allow";
