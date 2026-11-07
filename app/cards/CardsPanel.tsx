"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge, usd, when } from "@/components/ui";
import type { CardSecrets } from "@/lib/card-providers";
import type { CardPurchase } from "@/lib/types";

const TONE: Record<CardPurchase["status"], { label: string; tone: "ok" | "warn" | "bad" | "blue" | "default" }> = {
  awaiting_approval: { label: "Waiting for approval", tone: "warn" },
  issued: { label: "Card issued", tone: "blue" },
  used: { label: "Charged", tone: "ok" },
  closed: { label: "Closed", tone: "default" },
  refused: { label: "Refused", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};

type Result = { purchase: CardPurchase; card?: CardSecrets };

export function CardsPanel(props: {
  provider: string; signer: string; budget: number; spentToday: number; approvalFrom: number; perPayment: number; signersNeeded: number; killSwitch: boolean; purchases: CardPurchase[];
}) {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({ merchant: "", merchantUrl: "", amountUsd: "", reason: "" });
  // The card's number lives only in this component's memory, for this one showing. It is never stored, here or on the server.
  const [shown, setShown] = useState<{ id: string; card: CardSecrets } | null>(null);
  const [last, setLast] = useState<CardPurchase | null>(null);

  const took = (r: Result | null) => {
    if (!r) return;
    setLast(r.purchase);
    if (r.card) setShown({ id: r.purchase.id, card: r.card });
  };

  return (
    <div className="grid gap-4">
      <section className="card grid gap-1 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>{props.provider}</h2>
          {props.killSwitch ? <Badge tone="bad">Kill switch on: no cards</Badge> : props.budget > 0 ? <Badge tone="ok">Cards on</Badge> : <Badge tone="warn">No card budget in the policy</Badge>}
        </div>
        <p style={{ color: "var(--tx-1)" }}>
          Today: {usd(props.spentToday)} of {usd(props.budget)} on cards. Each card is at most {usd(props.perPayment)}; from {usd(props.approvalFrom)} it needs {props.signersNeeded} signer approval(s).
        </p>
      </section>

      {shown && (
        <section className="card" style={{ borderColor: "rgba(10,10,232,.45)" }} aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2>Card for {shown.id}</h2>
            <button className="btn btn-secondary btn-sm" onClick={() => setShown(null)}>Hide it now</button>
          </div>
          <dl className="mt-2 grid gap-1 mono text-sm">
            <div>Number: <span className="select-all">{shown.card.number}</span></div>
            <div>Expires: {shown.card.expiry} · CVC: <span className="select-all">{shown.card.cvc}</span></div>
          </dl>
          <p className="mt-2 text-xs" style={{ color: "var(--tx-2)" }}>Shown once. It is not stored anywhere: copy it into the checkout now. The card works only for this purchase, up to its amount.</p>
        </section>
      )}

      <form
        className="card grid gap-3 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          took(await run<Result>("/api/cards", { merchant: f.merchant, merchantUrl: f.merchantUrl || undefined, amountUsd: Number(f.amountUsd), reason: f.reason }));
        }}
      >
        <h2 className="sm:col-span-2">Buy with a one-time card</h2>
        <label className="block"><span className="label">Merchant</span>
          <input className="input mt-1" required maxLength={120} value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} /></label>
        <label className="block"><span className="label">Merchant website (optional)</span>
          <input className="input mt-1" type="url" placeholder="https://" value={f.merchantUrl} onChange={(e) => setF({ ...f, merchantUrl: e.target.value })} /></label>
        <label className="block"><span className="label">Most it may cost (USD, tax and shipping included)</span>
          <input className="input mt-1" required type="number" min="0.01" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} /></label>
        <label className="block"><span className="label">What it is for</span>
          <input className="input mt-1" required maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <div className="sm:col-span-2">
          <button className="btn btn-primary" disabled={loading}>{loading ? "Working…" : "Ask for a card"}</button>
          <ErrorLine msg={error} />
          {last && !shown && <p className="mt-2 text-sm" style={{ color: "var(--tx-1)" }}>{TONE[last.status].label}: {last.note}</p>}
        </div>
      </form>

      <section className="grid gap-3">
        {props.purchases.length === 0 && <p className="text-sm" style={{ color: "var(--tx-2)" }}>No card purchases yet.</p>}
        {props.purchases.map((p) => <Purchase key={p.id} p={p} signer={props.signer} onCard={took} />)}
      </section>
    </div>
  );
}

function Purchase({ p, signer, onCard }: { p: CardPurchase; signer: string; onCard: (r: Result | null) => void }) {
  const { run, error, loading } = useAction();
  const s = TONE[p.status];
  return (
    <article className="card text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{p.merchant} · {usd(p.amountUsd)}</h3>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="mt-1" style={{ color: "var(--tx-1)" }}>{p.reason}</p>
      <p className="mt-1 text-xs" style={{ color: "var(--tx-2)" }}>
        {p.id} · asked by {p.requestedBy} · {when(p.createdAt)}{p.last4 ? ` · card ending ${p.last4}` : ""}{p.merchantUrl ? ` · ${p.merchantUrl}` : ""}
      </p>
      {p.note && <p className="mt-2">{p.note}</p>}
      {p.authorizations.length > 0 && (
        <ul className="mt-2 grid gap-1 text-xs">
          {p.authorizations.map((a, i) => <li key={i}>{a.approved ? "✓ Approved" : "✕ Declined"} {usd(a.amountUsd)} from {a.merchant}: {a.reason}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {p.status === "awaiting_approval" && !p.approvals.includes(signer) && (
          <button className="btn btn-primary btn-sm" disabled={loading} onClick={async () => onCard(await run<Result>(`/api/cards/${p.id}`, { action: "approve" }))}>Approve</button>
        )}
        {(p.status === "awaiting_approval" || p.status === "issued" || p.status === "used") && (
          <button className="btn btn-danger btn-sm" disabled={loading} onClick={() => { if (window.confirm(p.status === "awaiting_approval" ? "Turn this purchase down?" : "Close this card now? It cannot be reopened.")) run(`/api/cards/${p.id}`, { action: "close" }); }}>
            {p.status === "awaiting_approval" ? "Turn down" : "Close card"}
          </button>
        )}
      </div>
      <ErrorLine msg={error} />
    </article>
  );
}
