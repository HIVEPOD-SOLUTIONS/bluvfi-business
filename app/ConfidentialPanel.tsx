"use client";
import { useState } from "react";
import { ActionButton, ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";

type Status = { state: "off" | "logged_in" | "needs_login" | "waiting_for_council" | "waiting_for_signature"; detail: string; proposalId?: number; loggedInUntil?: string };
type Shield = { stage: "none" | "deposit" | "sign" | "submitted" | "done" | "failed"; detail: string; amountUsd?: number };

/** Move some of the DAO's USDC into its shielded balance: one proposal deposits it, a second signs the shield. */
function ShieldBox({ shield, owner }: { shield: Shield; owner: boolean }) {
  const { run, error, loading } = useAction();
  const [usd, setUsd] = useState("");
  const open = shield.stage === "deposit" || shield.stage === "sign" || shield.stage === "submitted";
  return (
    <div className="mt-4 rounded-xl p-3 text-sm" style={{ background: "var(--bg-2)" }}>
      <div className="label">Shielded balance</div>
      <p className="mt-1" style={{ color: "var(--tx-1)" }}>
        {shield.stage === "none" ? "To pay confidentially, first move some of the DAO's USDC into its shielded balance. It takes two council approvals and every payout is then paid from it." : shield.detail}
      </p>
      {open && <div className="mt-2"><ActionButton url="/api/confidential" payload={{ action: "advance" }} variant="secondary" small>Check the council&apos;s vote</ActionButton></div>}
      {owner && !open && (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run("/api/confidential", { action: "shield", usd: Number(usd) })) setUsd(""); }}>
          <label className="block"><span className="label">USDC to shield</span><input className="input mt-1 w-32" type="number" min="0" step="0.01" required value={usd} onChange={(e) => setUsd(e.target.value)} /></label>
          <button className="btn btn-primary btn-sm" disabled={loading || !usd}>{loading ? "Filing…" : "Propose it"}</button>
        </form>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}

/**
 * A confidential treasury keeps its balance shielded in Confidential Intents, so reading it and paying from it need a login that
 * the DAO's council signs through NEAR's MPC signer (about weekly). Each payout is then approved by the council the same way.
 */
export function ConfidentialPanel({ on, status, shield, owner, canEnable }: { on: boolean; status: Status; shield: Shield; owner: boolean; canEnable: boolean }) {
  if (!on) {
    if (!canEnable || !owner) return null;
    return (
      <section className="card mt-6">
        <h2>Confidential treasury</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Keep this treasury&apos;s balance and payments out of public view. Funds are shielded in Confidential Intents; each payout is signed by NEAR&apos;s MPC signer after the council approves it.</p>
        <div className="mt-3"><ActionButton url="/api/confidential" payload={{ action: "enable" }} variant="secondary">Make this a confidential treasury</ActionButton></div>
      </section>
    );
  }
  const tone = status.state === "logged_in" ? "ok" : status.state === "needs_login" ? "bad" : "warn";
  return (
    <section className="card mt-6" style={{ borderColor: status.state === "logged_in" ? "var(--bd-sage)" : "rgba(232,168,56,.4)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>Confidential treasury</h2>
        <Badge tone={tone}>{status.state === "logged_in" ? "Logged in" : status.state === "needs_login" ? "Login needed" : "Waiting"}</Badge>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{status.detail}{status.loggedInUntil ? ` Until ${new Date(status.loggedInUntil).toLocaleString()}.` : ""}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {owner && status.state === "needs_login" && <ActionButton url="/api/confidential" payload={{ action: "login" }} variant="primary">Start the login</ActionButton>}
        {(status.state === "waiting_for_council" || status.state === "waiting_for_signature") && <ActionButton url="/api/confidential" payload={{ action: "check" }} variant="secondary">Check the council&apos;s vote</ActionButton>}
        {owner && status.state === "logged_in" && <ActionButton url="/api/confidential" payload={{ action: "disable" }} variant="ghost" small confirm="Stop using Confidential Intents for payouts?">Turn off</ActionButton>}
      </div>
      {status.state === "logged_in" && <ShieldBox shield={shield} owner={owner} />}
    </section>
  );
}
