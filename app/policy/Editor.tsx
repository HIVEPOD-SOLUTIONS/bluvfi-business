"use client";
import { useState } from "react";
import { ActionButton, ErrorLine, useAction } from "@/components/Actions";
import { LEVELS, PRIVACY_PROFILES, type PrivacyProfile } from "@/lib/privacy";
import type { Confidentiality, Policy } from "@/lib/types";

const tiersToText = (t: Policy["privacyTiers"]) => (t ?? []).map((x) => `${x.aboveUsd}: ${x.level}`).join("\n");
const vendorsToText = (v: Policy["privateVendors"]) => Object.entries(v ?? {}).map(([n, l]) => `${n}: ${l}`).join("\n");
const level = (s: string): Confidentiality => { const l = s.trim().toLowerCase() as Confidentiality; if (!LEVELS.includes(l)) throw new Error(`"${s.trim()}" is not a level: use public, basic or advanced.`); return l; };
const parseTiers = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).map((x) => { const [a, l] = x.split(":"); return { aboveUsd: Number(a.replace(/[$,]/g, "")), level: level(l ?? "") }; });
const parseVendors = (s: string) => Object.fromEntries(s.split("\n").map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.lastIndexOf(":"); if (i < 1) throw new Error(`"${x}": write the vendor, a colon, then the level.`); return [x.slice(0, i).trim(), level(x.slice(i + 1))]; }));

export function PolicyEditor({ policy, signer }: { policy: Policy; signer: string }) {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({
    perPaymentLimitUsd: String(policy.perPaymentLimitUsd), dailyLimitUsd: String(policy.dailyLimitUsd),
    approvalThresholdUsd: String(policy.approvalThresholdUsd), holdWindowMinutes: String(policy.holdWindowMinutes),
    x402DailyLimitUsd: String(policy.x402DailyLimitUsd), cardDailyLimitUsd: String(policy.cardDailyLimitUsd ?? 0), allowedChains: policy.allowedChains.join(", "),
    allowedAssets: policy.allowedAssets.join(", "), vendorAllowlist: policy.vendorAllowlist.join("\n"),
    privacyFloor: policy.privacyFloor ?? "public", requirePostQuantumKeys: !!policy.requirePostQuantumKeys,
    privacyProfile: (policy.privacyProfile ?? "") as PrivacyProfile | "", privacyTiers: tiersToText(policy.privacyTiers), privateVendors: vendorsToText(policy.privateVendors),
    verifyVendorsFromUsd: policy.verifyVendorsFromUsd === undefined ? "" : String(policy.verifyVendorsFromUsd),
    verifyBusinessFromUsd: policy.verifyBusinessFromUsd === undefined ? "" : String(policy.verifyBusinessFromUsd),
    verifyNewVendors: !!policy.verifyNewVendors, verifyForPrivacy: !!policy.verifyForPrivacy, acceptPassportProof: policy.acceptPassportProof !== false,
  });
  // An empty amount means "no rule": nobody is asked to verify because of the amount.
  const optionalUsd = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);
  const list = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const num = (k: "perPaymentLimitUsd" | "dailyLimitUsd" | "approvalThresholdUsd" | "holdWindowMinutes" | "x402DailyLimitUsd" | "cardDailyLimitUsd", label: string, hint?: string) => (
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
        setFormError("");
        let privacyTiers: ReturnType<typeof parseTiers>, privateVendors: ReturnType<typeof parseVendors>;
        try { privacyTiers = parseTiers(f.privacyTiers); privateVendors = parseVendors(f.privateVendors); } catch (err) { setFormError((err as Error).message); return; }
        const ok = await run("/api/policy", {
          changes: {
            perPaymentLimitUsd: Number(f.perPaymentLimitUsd), dailyLimitUsd: Number(f.dailyLimitUsd),
            approvalThresholdUsd: Number(f.approvalThresholdUsd), holdWindowMinutes: Number(f.holdWindowMinutes),
            x402DailyLimitUsd: Number(f.x402DailyLimitUsd), cardDailyLimitUsd: Number(f.cardDailyLimitUsd), allowedChains: list(f.allowedChains, /[,\s]+/),
            allowedAssets: list(f.allowedAssets, /[,\s]+/).map((a) => a.toUpperCase()), vendorAllowlist: list(f.vendorAllowlist, /\n/),
            privacyFloor: f.privacyFloor, requirePostQuantumKeys: f.requirePostQuantumKeys,
            ...(f.privacyProfile ? { privacyProfile: f.privacyProfile } : {}), privacyTiers, privateVendors,
            verifyVendorsFromUsd: optionalUsd(f.verifyVendorsFromUsd), verifyBusinessFromUsd: optionalUsd(f.verifyBusinessFromUsd),
            verifyNewVendors: f.verifyNewVendors, verifyForPrivacy: f.verifyForPrivacy, acceptPassportProof: f.acceptPassportProof,
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
      {num("cardDailyLimitUsd", "Card spend per day (USD)", "One-time cards for card checkouts. 0 gives the agent no cards.")}
      <label className="block"><span className="label">Allowed chains</span>
        <input className="input mt-1" value={f.allowedChains} onChange={(e) => setF({ ...f, allowedChains: e.target.value })} /></label>
      <label className="block"><span className="label">Allowed assets</span>
        <input className="input mt-1" value={f.allowedAssets} onChange={(e) => setF({ ...f, allowedAssets: e.target.value })} /></label>
      <label className="block sm:col-span-2"><span className="label">Who needs privacy: treasury type</span>
        <select className="input mt-1" value={f.privacyProfile} onChange={(e) => {
          const p = e.target.value as PrivacyProfile | "";
          setF(p ? { ...f, privacyProfile: p, privacyFloor: PRIVACY_PROFILES[p].floor, privacyTiers: tiersToText(PRIVACY_PROFILES[p].tiers) } : { ...f, privacyProfile: "" });
        }}>
          <option value="">Custom (set the rules below)</option>
          {(Object.keys(PRIVACY_PROFILES) as PrivacyProfile[]).map((k) => <option key={k} value={k}>{PRIVACY_PROFILES[k].label}</option>)}
        </select>
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>{f.privacyProfile ? PRIVACY_PROFILES[f.privacyProfile].who : "Privacy is optional and set by your council. Pick a type to fill in the rules, then adjust them."}</span></label>
      <label className="block"><span className="label">Privacy floor</span>
        <select className="input mt-1" value={f.privacyFloor} onChange={(e) => setF({ ...f, privacyFloor: e.target.value as Policy["privacyFloor"] & string })}>
          <option value="public">None: each payment chooses</option>
          <option value="basic">Basic or more</option>
          <option value="advanced">Advanced: confidential payments only</option>
        </select>
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>Privacy is optional. Teams that need it (investors, institutions) set a floor every payment must meet.</span></label>
      <label className="flex items-start gap-2 self-end">
        <input type="checkbox" className="mt-1" checked={f.requirePostQuantumKeys} onChange={(e) => setF({ ...f, requirePostQuantumKeys: e.target.checked })} />
        <span><span className="label">Require post-quantum keys</span><br />
          <span className="text-xs" style={{ color: "var(--tx-2)" }}>Refuse payouts unless the agent, relayer and every council member sign with ML-DSA keys, which quantum computers are not known to break.</span></span>
      </label>
      <label className="block"><span className="label">Amount tiers (one per line: amount: level)</span>
        <textarea className="input mt-1" placeholder={"5000: basic\n25000: advanced"} value={f.privacyTiers} onChange={(e) => setF({ ...f, privacyTiers: e.target.value })} />
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>Payments at or above an amount go out at least at that level.</span></label>
      <label className="block"><span className="label">Vendors who need privacy (one per line: vendor: level)</span>
        <textarea className="input mt-1" placeholder={"Payroll Co: advanced\nSeed Investors LLC: basic"} value={f.privateVendors} onChange={(e) => setF({ ...f, privateVendors: e.target.value })} />
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>Payroll, contractors, investors, legal: always at least this level, whatever the amount.</span></label>
      <div className="sm:col-span-2">
        <span className="label">Who has to verify, and when</span>
        <p className="text-xs" style={{ color: "var(--tx-2)" }}>Most payments should ask nobody for anything. Leave an amount empty for no amount rule; 0 means always.</p>
      </div>
      <label className="block"><span className="label">Vendor verified from (USD)</span>
        <input className="input mt-1" type="number" min="0" placeholder="no amount rule" value={f.verifyVendorsFromUsd} onChange={(e) => setF({ ...f, verifyVendorsFromUsd: e.target.value })} />
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>Payments to an unverified vendor at or above this are blocked until the vendor verifies.</span></label>
      <label className="block"><span className="label">Your business verified from (USD)</span>
        <input className="input mt-1" type="number" min="0" placeholder="no amount rule" value={f.verifyBusinessFromUsd} onChange={(e) => setF({ ...f, verifyBusinessFromUsd: e.target.value })} />
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>Payments at or above this wait until your own business is verified.</span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.verifyNewVendors} onChange={(e) => setF({ ...f, verifyNewVendors: e.target.checked })} />
        <span><span className="label">New vendors verify first</span><br /><span className="text-xs" style={{ color: "var(--tx-2)" }}>A vendor never paid before must verify, whatever the amount.</span></span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.verifyForPrivacy} onChange={(e) => setF({ ...f, verifyForPrivacy: e.target.checked })} />
        <span><span className="label">Verify for confidential payments</span><br /><span className="text-xs" style={{ color: "var(--tx-2)" }}>Your business must be verified to pay at the &quot;advanced&quot; privacy level.</span></span></label>
      <label className="flex items-start gap-2 sm:col-span-2"><input type="checkbox" className="mt-1" checked={f.acceptPassportProof} onChange={(e) => setF({ ...f, acceptPassportProof: e.target.checked })} />
        <span><span className="label">Accept a passport proof</span><br /><span className="text-xs" style={{ color: "var(--tx-2)" }}>A zero-knowledge proof from a passport chip (Self) counts as verified: a real passport holder, of age, not on OFAC lists. No name or document is shared. Off means Persona only.</span></span></label>
      <label className="block sm:col-span-2"><span className="label">Vendor allowlist (one per line)</span>
        <textarea className="input mt-1" value={f.vendorAllowlist} onChange={(e) => setF({ ...f, vendorAllowlist: e.target.value })} /></label>
      <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
        <span className="text-sm" style={{ color: "var(--tx-2)" }}>Proposing as <span className="mono">{signer}</span></span>
        <button className="btn btn-primary" disabled={loading}>{loading ? "Proposing…" : "Create proposal"}</button>
        {sent && <span role="status" className="text-sm pos">Proposal created. It needs more signers.</span>}
      </div>
      <div className="sm:col-span-2"><ErrorLine msg={formError || error} /></div>
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
