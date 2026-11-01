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

/** A change waiting on the treasury DAO: what to put to the council, and a button that reads the DAO from the chain. */
export function DaoProposalBox({ id, dao }: { id: string; dao: { description: string; command: string; url: string; proposalId?: number; daoStatus?: string } }) {
  return (
    <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: "var(--bg-2)" }}>
      <p style={{ color: "var(--tx-1)" }}>
        The treasury DAO&apos;s council approves this, onchain. The agent files it as a proposal that does nothing but carry this text (it can only propose), or a council member adds the same proposal from a terminal. The council votes in <a href={dao.url} style={{ color: "#8c8cff" }}>Trezu</a>, then check the DAO. The change applies only once the chain says Approved.
        {dao.proposalId !== undefined && <> DAO proposal #{dao.proposalId}: <strong>{dao.daoStatus}</strong>.</>}
      </p>
      <div className="label mt-2">Proposal text</div>
      <pre className="mono mt-1 overflow-auto whitespace-pre-wrap text-xs">{dao.description}</pre>
      {dao.proposalId === undefined && <div className="mt-3"><ActionButton url="/api/policy" payload={{ sendId: id }} variant="primary" small>Send to the DAO from the agent</ActionButton></div>}
      <div className="label mt-2">Or from a terminal</div>
      <pre className="mono mt-1 overflow-auto whitespace-pre-wrap break-all text-xs">{dao.command}</pre>
    </div>
  );
}

export function ProposalActions({ id, signer, approved, dao }: { id: string; signer: string; approved: boolean; dao?: boolean }) {
  if (dao) return <div className="mt-3"><ActionButton url="/api/policy" payload={{ syncId: id }} variant="secondary" small>Check the DAO</ActionButton></div>;
  if (approved) return <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>You approved this. It needs other signers.</p>;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <ActionButton url="/api/policy" payload={{ approveId: id }} variant="secondary" small>Approve as {signer}</ActionButton>
    </div>
  );
}
