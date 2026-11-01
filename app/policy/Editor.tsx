"use client";
import { useState } from "react";
import { ActionButton, ErrorLine, useAction } from "@/components/Actions";
import type { Policy } from "@/lib/types";

export function PolicyEditor({ policy, signer }: { policy: Policy; signer: string }) {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({
    perPaymentLimitUsd: String(policy.perPaymentLimitUsd), dailyLimitUsd: String(policy.dailyLimitUsd),
    approvalThresholdUsd: String(policy.approvalThresholdUsd), holdWindowMinutes: String(policy.holdWindowMinutes),
    x402DailyLimitUsd: String(policy.x402DailyLimitUsd), allowedChains: policy.allowedChains.join(", "),
    allowedAssets: policy.allowedAssets.join(", "), vendorAllowlist: policy.vendorAllowlist.join("\n"),
  });
  const [sent, setSent] = useState(false);
  const list = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const num = (k: keyof typeof f, label: string, hint?: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input mt-1" type="number" min="0" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {hint && <span className="text-xs" style={{ color: "var(--tx-2)" }}>{hint}</span>}
    </label>
  );
  return (
    <form
      className="card grid gap-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setSent(false);
        const ok = await run("/api/policy", {
          changes: {
            perPaymentLimitUsd: Number(f.perPaymentLimitUsd), dailyLimitUsd: Number(f.dailyLimitUsd),
            approvalThresholdUsd: Number(f.approvalThresholdUsd), holdWindowMinutes: Number(f.holdWindowMinutes),
            x402DailyLimitUsd: Number(f.x402DailyLimitUsd), allowedChains: list(f.allowedChains, /[,\s]+/),
            allowedAssets: list(f.allowedAssets, /[,\s]+/).map((a) => a.toUpperCase()), vendorAllowlist: list(f.vendorAllowlist, /\n/),
          },
        });
        if (ok) setSent(true);
      }}
    >
      {num("perPaymentLimitUsd", "Per-payment limit (USD)")}
      {num("dailyLimitUsd", "Daily limit (USD)")}
      {num("approvalThresholdUsd", "Signer approval from (USD)", "Payments at or above this need a human.")}
      {num("holdWindowMinutes", "Hold window (minutes)", "How long suspicious payments wait.")}
      {num("x402DailyLimitUsd", "API spend per day (USD)", "For x402 paywalls the agent buys from.")}
      <label className="block"><span className="label">Allowed chains</span>
        <input className="input mt-1" value={f.allowedChains} onChange={(e) => setF({ ...f, allowedChains: e.target.value })} /></label>
      <label className="block"><span className="label">Allowed assets</span>
        <input className="input mt-1" value={f.allowedAssets} onChange={(e) => setF({ ...f, allowedAssets: e.target.value })} /></label>
      <label className="block sm:col-span-2"><span className="label">Vendor allowlist (one per line)</span>
        <textarea className="input mt-1" value={f.vendorAllowlist} onChange={(e) => setF({ ...f, vendorAllowlist: e.target.value })} /></label>
      <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
        <span className="text-sm" style={{ color: "var(--tx-2)" }}>Proposing as <span className="mono">{signer}</span></span>
        <button className="btn btn-primary" disabled={loading}>{loading ? "Proposing…" : "Create proposal"}</button>
        {sent && <span role="status" className="text-sm pos">Proposal created. It needs more signers.</span>}
      </div>
      <div className="sm:col-span-2"><ErrorLine msg={error} /></div>
    </form>
  );
}

export function ProposalActions({ id, signer, approved }: { id: string; signer: string; approved: boolean }) {
  if (approved) return <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>You approved this. It needs other signers.</p>;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <ActionButton url="/api/policy" payload={{ approveId: id }} variant="secondary" small>Approve as {signer}</ActionButton>
    </div>
  );
}
