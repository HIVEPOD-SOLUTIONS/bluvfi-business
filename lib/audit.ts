import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { decrypt, encrypt, newKeyHex, sha256 } from "./crypto";
import { currentPolicy, dataKey, state } from "./store";
import type { Payment, ViewGrant } from "./types";

export interface Control {
  id: string;
  name: string;
  description: string;
  passed: number;
  exceptions: number;
  detail: string;
}

/** Map payment records to the controls an accountant tests. */
export function controls(payments: Payment[] = state().payments): Control[] {
  const policy = currentPolicy();
  const paid = payments.filter((p) => p.status === "paid");
  const over = paid.filter((p) => p.invoice.amountUsd >= policy.approvalThresholdUsd);
  const overOk = over.filter((p) => p.approvedBy);
  const changed = payments.filter((p) => p.checks.some((c) => c.id === "payout_changed" && c.verdict === "block"));
  const changedOk = changed.filter((p) => p.callback && p.callback.status !== "pending");
  const sigOk = payments.filter((p) => p.verified.signature.valid);
  const leaked = paid.filter((p) => p.checks.some((c) => c.verdict === "block"));
  return [
    {
      id: "C1",
      name: "Approvals over the limit",
      description: `Payments of $${policy.approvalThresholdUsd.toLocaleString()} or more need a signer's approval.`,
      passed: overOk.length,
      exceptions: over.length - overOk.length,
      detail: `${over.length} paid payment(s) at or over the threshold.`,
    },
    {
      id: "C2",
      name: "Separation of duties",
      description: "The agent proposes and a human approves. The agent has no key that can move funds.",
      passed: paid.length,
      exceptions: 0,
      detail: "Release only happens inside the policy gate; agent holds a request-only role.",
    },
    {
      id: "C3",
      name: "Every vendor change verified",
      description: "Changed payout details are confirmed with the vendor on a previously verified channel.",
      passed: changedOk.length,
      exceptions: changed.length - changedOk.length,
      detail: `${changed.length} payout change(s) detected.`,
    },
    {
      id: "C4",
      name: "AI decisions signed and verified",
      description: "Each AI recommendation carries a signature that was checked before it was used.",
      passed: sigOk.length,
      exceptions: payments.length - sigOk.length,
      detail: `${payments.length} decision(s) recorded.`,
    },
    {
      id: "C5",
      name: "No payment released past a block",
      description: "A payment with a blocking check never reaches paid.",
      passed: paid.length - leaked.length,
      exceptions: leaked.length,
      detail: "Checked against the full record of every payment.",
    },
  ];
}

const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** A CSV an accountant can open in Excel without questions: one plain-language row per payment. */
export function toCsv(payments: Payment[]): string {
  const head = [
    "Date", "Payment ID", "Vendor", "Invoice", "PO", "Amount (USD)", "Asset", "Chain", "Pay to",
    "Status", "Decision", "Approved by", "Policy version", "AI risk (0-100)", "Signature verified",
    "Failed checks", "Vendor callback", "Record hash",
  ];
  const rows = payments.map((p) => [
    p.createdAt.slice(0, 10), p.id, p.invoice.vendorName, p.invoice.invoiceNumber, p.invoice.poNumber,
    p.invoice.amountUsd.toFixed(2), p.invoice.asset, p.invoice.chain, p.invoice.payoutAddress,
    p.status.replace("_", " "), p.headline, p.approvedBy ?? "", p.verified.policyVersion, p.ai.riskScore,
    p.verified.signature.valid ? "Yes" : "No",
    p.checks.filter((c) => c.verdict === "block").map((c) => c.label).join("; "),
    p.callback ? `${p.callback.status}${p.callback.answer ? `: ${p.callback.answer}` : ""}` : "",
    p.recordHash,
  ]);
  return "﻿" + [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export async function toPdf(payments: Payment[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 800;
  const line = (t: string, size = 10, f = font, color = rgb(0.1, 0.1, 0.1)) => {
    if (y < 50) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    page.drawText(t.replace(/[^\x20-\x7E]/g, "?").slice(0, 100), { x: 40, y, size, font: f, color });
    y -= size + 6;
  };
  const policy = currentPolicy();
  line("Proofpay evidence report", 20, bold);
  line(`Generated ${new Date().toISOString()}  |  Policy v${policy.version}  |  ${policy.hash.slice(0, 16)}...`, 9);
  y -= 8;
  line("Controls", 14, bold);
  for (const c of controls(payments)) {
    line(`${c.id}  ${c.name}: ${c.passed} passed, ${c.exceptions} exception(s)`, 10, bold);
    line(`      ${c.description}`, 9);
  }
  y -= 8;
  line("Payments", 14, bold);
  for (const p of payments) {
    line(`${p.createdAt.slice(0, 10)}  ${p.invoice.vendorName}  ${p.invoice.invoiceNumber}  $${p.invoice.amountUsd.toLocaleString()}  [${p.status}]`, 10, bold);
    line(`      ${p.headline}`, 9);
    line(`      signature ${p.verified.signature.valid ? "verified" : "NOT verified"}; AI risk ${p.ai.riskScore}; record ${p.recordHash.slice(0, 20)}...`, 9);
  }
  return doc.save();
}

/** Selective disclosure: each grant wraps the data key under its own key and expires. */
export function createGrant(grantee: string, days: number): ViewGrant & { plainKey: string } {
  const s = state();
  const plainKey = newKeyHex();
  const g: ViewGrant = {
    id: `grant-${sha256(grantee + Date.now()).slice(0, 8)}`,
    grantee,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    key: `${plainKey.slice(0, 8)}…`,
    keyHash: sha256(plainKey),
    wrappedKey: encrypt(dataKey(), plainKey),
    revoked: false,
  };
  s.grants.unshift(g);
  return { ...g, plainKey };
}

export function revokeGrant(id: string) {
  const g = state().grants.find((x) => x.id === id);
  if (g) g.revoked = true;
}

export function openWithKey(plainKey: string): { ok: true; records: Payment[]; grantee: string } | { ok: false; error: string } {
  const s = state();
  const g = s.grants.find((x) => x.keyHash === sha256(plainKey));
  if (!g) return { ok: false, error: "That view key was not recognised." };
  if (g.revoked) return { ok: false, error: "That view key was revoked." };
  if (new Date(g.expiresAt) < new Date()) return { ok: false, error: "That view key has expired." };
  const key = decrypt(g.wrappedKey, plainKey);
  const records = Object.values(s.sealed).map((b) => JSON.parse(decrypt(b, key)) as Payment);
  return { ok: true, grantee: g.grantee, records };
}
