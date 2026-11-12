"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import type { PayFromChain } from "@/lib/intents-tokens";
import type { Quote, Receivable } from "@/lib/types";

/** Pay by hand to a NEAR Intents deposit address: any chain and token 1Click supports, in, and USDC on NEAR out. */
export function PayWidget({ id, paid, deposit, note, chains }: { id: string; paid: boolean; deposit: Receivable["deposit"] | null; note?: string; chains: PayFromChain[] }) {
  const { run, error, loading } = useAction();
  const [chain, setChain] = useState(chains[0]?.chain ?? "");
  const tokens = chains.find((c) => c.chain === chain)?.tokens ?? [];
  const [asset, setAsset] = useState(tokens[0]?.assetId ?? "");
  const symbol = tokens.find((t) => t.assetId === asset)?.symbol ?? "";
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<(Pick<Quote, "amountIn" | "amountOut" | "depositAddress" | "depositMemo" | "deadline"> & { symbol: string }) | null>(
    deposit ? { amountIn: deposit.amountIn, amountOut: "", depositAddress: deposit.address, depositMemo: deposit.memo, deadline: deposit.deadline, symbol: deposit.symbol ?? "USDC" } : null
  );
  const [status, setStatus] = useState<{ status: string; note: string } | null>(note ? { status: "", note } : null);
  if (paid) return <p className="mt-4 badge badge-ok">Paid. Thank you ✓</p>;
  const chainName = chains.find((c) => c.chain === chain)?.name ?? chain;
  return (
    <div className="mt-5">
      <div className="grid grid-cols-[3fr_2fr] gap-2">
        <label className="block"><span className="label">Pay from ({chains.length} chains)</span>
          <select
            className="input mt-1" value={chain}
            onChange={(e) => { const c = e.target.value; setChain(c); setAsset(chains.find((x) => x.chain === c)?.tokens[0]?.assetId ?? ""); setQuote(null); }}
          >
            {chains.map((c) => <option key={c.chain} value={c.chain}>{c.name}</option>)}
          </select>
        </label>
        <label className="block"><span className="label">With</span>
          <select className="input mt-1" value={asset} onChange={(e) => { setAsset(e.target.value); setQuote(null); }}>
            {tokens.map((t) => <option key={t.assetId} value={t.assetId}>{t.symbol}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block"><span className="label">Your refund address on {chainName}</span>
        <input className="input mt-1" value={refundTo} maxLength={200} onChange={(e) => setRefundTo(e.target.value)} placeholder="Where a refund goes if the payment fails" />
      </label>
      <button
        className="btn btn-primary mt-3 w-full"
        disabled={loading || !refundTo.trim() || !asset}
        onClick={async () => {
          const r = await run<{ quote: Quote }>(`/api/pay/${id}`, { fromAsset: asset, refundTo });
          if (r) setQuote({ ...r.quote, symbol });
        }}
      >
        {loading ? "Getting quote…" : "Get payment instructions"}
      </button>
      {quote && (
        <div className="toast-in mt-4 rounded-xl p-4 text-sm" style={{ background: "var(--bg-2)" }}>
          <div>Send exactly <span className="amount">{quote.amountIn}</span> {quote.symbol} to:</div>
          <div className="mono mt-1 break-all text-xs">{quote.depositAddress}</div>
          {quote.depositMemo && <div className="mt-2 text-xs"><span className="label">Memo (required)</span> <span className="mono">{quote.depositMemo}</span></div>}
          {quote.deadline && <div className="mt-2 text-xs" style={{ color: "var(--tx-2)" }}>Before {new Date(quote.deadline).toLocaleString()}. Sending later or a different amount may fail and be refunded.</div>}
          <button
            className="btn btn-secondary btn-sm mt-3"
            disabled={loading} aria-busy={loading}
            onClick={async () => {
              const r = await run<{ status: string; note: string; receivable: Receivable }>(`/api/pay/${id}`, { check: true });
              if (!r) return;
              setStatus({ status: r.status, note: r.note });
              if (!r.receivable.deposit) setQuote(null); // refunded, failed or expired: the client asks for fresh instructions
            }}
          >I have sent it: check payment</button>
        </div>
      )}
      {status && <div role="status" className="mt-3 text-sm">{status.status && <span className="mono text-xs">{status.status}: </span>}{status.note}</div>}
      <ErrorLine msg={error} />
    </div>
  );
}
