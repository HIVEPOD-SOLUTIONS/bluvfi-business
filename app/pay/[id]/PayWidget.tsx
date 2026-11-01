"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import type { Quote, Receivable } from "@/lib/types";

export function PayWidget({ id, paid, deposit }: { id: string; paid: boolean; deposit: Receivable["deposit"] | null }) {
  const { run, error, loading } = useAction();
  const [chain, setChain] = useState("eth");
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<Pick<Quote, "amountIn" | "amountOut" | "depositAddress" | "depositMemo" | "deadline"> | null>(
    deposit ? { amountIn: deposit.amountIn, amountOut: "", depositAddress: deposit.address, depositMemo: deposit.memo, deadline: deposit.deadline } : null
  );
  const [status, setStatus] = useState<string | null>(null);
  if (paid) return <p className="mt-4 badge badge-ok">Paid. Thank you ✓</p>;
  return (
    <div className="mt-5">
      <label className="block"><span className="label">Pay from</span>
        <select className="input mt-1" value={chain} onChange={(e) => { setChain(e.target.value); setQuote(null); }}>
          {[["eth", "Ethereum"], ["base", "Base"], ["arb", "Arbitrum"], ["sol", "Solana"], ["near", "NEAR"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="mt-3 block"><span className="label">Your refund address on that chain</span>
        <input className="input mt-1" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder="Where a refund goes if the payment fails" />
      </label>
      <button
        className="btn btn-primary mt-3 w-full"
        disabled={loading || !refundTo.trim()}
        onClick={async () => {
          const r = await run<{ quote: Quote }>(`/api/pay/${id}`, { fromChain: chain, refundTo });
          if (r) setQuote(r.quote);
        }}
      >
        {loading ? "Getting quote…" : "Get payment instructions"}
      </button>
      {quote && (
        <div className="toast-in mt-4 rounded-xl p-4 text-sm" style={{ background: "var(--bg-2)" }}>
          <div>Send exactly <span className="amount">{quote.amountIn}</span> USDC to:</div>
          <div className="mono mt-1 break-all text-xs">{quote.depositAddress}</div>
          {quote.depositMemo && <div className="mt-2 text-xs"><span className="label">Memo (required)</span> <span className="mono">{quote.depositMemo}</span></div>}
          {quote.deadline && <div className="mt-2 text-xs" style={{ color: "var(--tx-2)" }}>Before {new Date(quote.deadline).toLocaleString()}. Sending later or a different amount may fail and be refunded.</div>}
          <button
            className="btn btn-secondary btn-sm mt-3"
            disabled={loading}
            onClick={async () => { const r = await run<{ status: string }>(`/api/pay/${id}`, { check: true }); if (r) setStatus(r.status); }}
          >I have sent it: check payment</button>
          {status && <div role="status" className="mono mt-2 text-xs">Status: {status}</div>}
        </div>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}
