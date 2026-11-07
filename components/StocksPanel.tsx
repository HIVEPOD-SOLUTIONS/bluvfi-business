"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import { PriceChart } from "@/components/PriceChart";
import type { Account, Stock, TradeResult } from "@/lib/stocks";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** US stocks and ETFs on the business's own Backpack account: browse with charts, fund it from the treasury, buy and sell within the council's cap. */
export function StocksPanel({ configured, initial }: { configured: boolean; initial: Stock[] | null }) {
  const [stocks, setStocks] = useState<Stock[] | null>(initial);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const [limit, setLimit] = useState(25);

  useEffect(() => {
    if (initial) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/stocks", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) setError(json.error ?? `Something went wrong (${res.status}).`); else setStocks(json.stocks);
      } catch { setError("Could not reach the server."); }
    }, 0);
    return () => clearTimeout(t);
  }, [initial]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    const all = stocks ?? [];
    return (n ? all.filter((s) => s.ticker.toLowerCase().includes(n) || s.name.toLowerCase().includes(n)) : all).slice(0, n ? 100 : limit);
  }, [stocks, q, limit]);

  return (
    <div className="grid gap-5">
      {configured ? <AccountCard /> : <div className="card"><h2>Connect your Backpack account</h2><p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>You can browse prices and charts now. To fund an account and trade, an owner adds this business&apos;s Backpack API key and secret on the Settings page.</p></div>}
      <div>
        <input className="input max-w-xs" placeholder="Search a stock or ETF" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stocks" />
        {error && <p role="alert" className="shake mt-3 text-sm neg">{error}</p>}
        <div className="card mt-3 overflow-x-auto p-0">
          <table className="t">
            <thead><tr className="label"><th>Stock</th><th className="text-right">Price</th><th className="text-right">24h</th></tr></thead>
            <tbody>
              {rows.flatMap((s) => [
                <tr key={s.asset} className="reveal">
                  <td><button className="text-left" aria-expanded={open === s.asset} onClick={() => setOpen(open === s.asset ? "" : s.asset)}><strong>{s.ticker}</strong> <span style={{ color: "var(--tx-1)" }}>{s.name}</span> <span aria-hidden style={{ color: "var(--tx-2)" }}>{open === s.asset ? "▾" : "▸"}</span></button></td>
                  <td className="amount text-right">{s.priceUsd === null ? "–" : usd(s.priceUsd)}</td>
                  <td className={`mono text-right ${s.change24hPct === null ? "" : s.change24hPct >= 0 ? "pos" : "neg"}`}>{s.change24hPct === null ? "–" : `${s.change24hPct >= 0 ? "▲" : "▼"} ${Math.abs(s.change24hPct).toFixed(2)}%`}</td>
                </tr>,
                ...(open === s.asset ? [<tr key={`${s.asset}-more`}><td colSpan={3} className="p-0"><PriceChart symbol={s.asset} kind="stock" />{configured && <TradeForm stock={s} />}</td></tr>] : []),
              ])}
              {!stocks && !error && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={3}><div className="skeleton h-5 my-1" /></td></tr>)}
              {stocks && rows.length === 0 && <tr><td colSpan={3} className="py-6 text-center" style={{ color: "var(--tx-1)" }}>No stock matches that.</td></tr>}
            </tbody>
          </table>
        </div>
        {!q && stocks && limit < stocks.length && <div className="mt-3 text-center"><button className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + 50)}>Show more</button></div>}
      </div>
    </div>
  );
}

function AccountCard() {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const [acct, setAcct] = useState<(Account & { deposit: string }) | null>(null);
  const [err, setErr] = useState("");
  const [amount, setAmount] = useState("");
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/stocks?account=1", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error ?? `Something went wrong (${res.status}).`); setAcct(null); } else { setAcct(json); setErr(""); }
    } catch { setErr("Could not reach the server."); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  return (
    <div className="card grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2>Your Backpack account</h2><button className="btn btn-ghost btn-sm" onClick={() => void load()}>Refresh</button></div>
      {err && <p role="alert" className="text-sm neg">{err}</p>}
      {!acct && !err && <div className="skeleton h-12" />}
      {acct && (
        <>
          <p className="text-sm">Cash to spend <strong className="amount">{usd(acct.usdc)}</strong>{acct.positions.length ? <> · Holding {acct.positions.map((p) => `${p.quantity} ${p.asset.replace(".US", "")}`).join(", ")}</> : " · No shares yet"}</p>
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run<{ payment: { id: string } }>("/api/stocks", { action: "fund", amountUsd: Number(amount) }, "POST", "Payment made: now it needs approval");
            if (r) router.push(`/payments/${r.payment.id}`);
          }}>
            <label className="block"><span className="label">Put in from the treasury (USDC)</span><input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100" /></label>
            <button className="btn btn-primary" disabled={loading || !(Number(amount) >= 10)}>{loading ? "Creating…" : "Fund the account"}</button>
          </form>
          <p className="text-xs" style={{ color: "var(--tx-2)" }}>This is a USDC payment on Base to your own account&apos;s deposit address (<span className="mono break-all">{acct.deposit}</span>). Your rules check it and your treasury approves it. Withdrawals are made in Backpack itself.</p>
          <ErrorLine msg={error} />
        </>
      )}
    </div>
  );
}

function TradeForm({ stock }: { stock: Stock }) {
  const { run, error, loading } = useAction();
  const [amount, setAmount] = useState("");
  const [done, setDone] = useState<TradeResult | null>(null);
  const go = async (side: "buy" | "sell") => {
    if (!window.confirm(`${side === "buy" ? "Buy" : "Sell"} about ${usd(Number(amount))} of ${stock.ticker}, at no worse than a 1% move from the price shown?`)) return;
    const r = await run<{ trade: TradeResult }>("/api/stocks", { action: "trade", asset: stock.asset, side, amountUsd: Number(amount) }, "POST", "Order sent");
    if (r) setDone(r.trade);
  };
  return (
    <div className="grid gap-2 px-4 pb-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="label">Amount in dollars</span><input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50" /></label>
        <button className="btn btn-primary btn-sm" disabled={loading || !(Number(amount) > 0)} onClick={() => void go("buy")}>Buy {stock.ticker}</button>
        <button className="btn btn-secondary btn-sm" disabled={loading || !(Number(amount) > 0)} onClick={() => void go("sell")}>Sell</button>
      </div>
      {done && <p className="text-sm pos">{done.status}{done.filledQty ? `: ${done.filledQty} shares for ${usd(done.spentUsd ?? 0)}` : ""} (limit {usd(done.capPrice)} a share, via {done.via === "rfq" ? "request for quote" : "the order book"}).</p>}
      <ErrorLine msg={error} />
    </div>
  );
}
