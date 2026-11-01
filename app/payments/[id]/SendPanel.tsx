"use client";
import { useState } from "react";
import { ActionButton, ErrorLine, useAction } from "@/components/Actions";
import { when } from "@/components/ui";
import type { Payment, Quote } from "@/lib/types";

export function SendPanel({
  id, quote, txRef, settlement, signedIn, asset, chain,
}: { id: string; quote: Quote; txRef?: string; settlement?: Payment["settlement"]; signedIn: boolean; asset: string; chain: string }) {
  const { run, error, loading } = useAction();
  const [tx, setTx] = useState("");
  return (
    <section className="card mb-4" style={{ borderColor: "rgba(10,10,232,.5)" }}>
      <h2>Send the funds</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
        Approved. Proofpay holds no treasury key, so a signer sends this from the treasury wallet. NEAR Intents then delivers {quote.amountOut} {asset} on {chain}.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt style={{ color: "var(--tx-2)" }}>Send</dt><dd className="amount">{quote.amountIn} USDC (NEAR mainnet)</dd>
        <dt style={{ color: "var(--tx-2)" }}>To</dt><dd className="mono break-all">{quote.depositAddress}</dd>
        {quote.depositMemo && (<><dt style={{ color: "var(--tx-2)" }}>Memo</dt><dd className="mono break-all">{quote.depositMemo} <span style={{ color: "var(--amber)" }}>(required)</span></dd></>)}
        {quote.deadline && (<><dt style={{ color: "var(--tx-2)" }}>Before</dt><dd>{when(quote.deadline)}</dd></>)}
        {txRef && (<><dt style={{ color: "var(--tx-2)" }}>Reported tx</dt><dd className="mono break-all">{txRef}</dd></>)}
        {settlement && (<><dt style={{ color: "var(--tx-2)" }}>1Click status</dt><dd className="mono">{settlement.status} · {when(settlement.checkedAt)}</dd></>)}
      </dl>
      {signedIn && (
        <div className="mt-4 grid gap-3">
          {!txRef && (
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); run(`/api/payments/${id}/sent`, { txRef: tx }); }}>
              <input className="input min-w-0 flex-1" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="Transaction hash you sent" aria-label="Transaction hash" />
              <button className="btn btn-primary" disabled={loading || !tx.trim()}>I sent it</button>
            </form>
          )}
          <div><ActionButton url={`/api/payments/${id}/settlement`} variant="secondary">Check settlement</ActionButton></div>
        </div>
      )}
      <ErrorLine msg={error} />
    </section>
  );
}
