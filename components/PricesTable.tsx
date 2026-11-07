"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Market } from "@/lib/prices";
import { PriceChart } from "./PriceChart";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1 ? 2 : 6 });
const big = (n: number | null) => (n === null ? "–" : n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString()}`);

/** Live prices: search by name or ticker, refreshed every minute (the sources only refresh that often), with a calm note of how fresh it is. */
export function PricesTable({ initial, holdings }: { initial: Market | null; holdings: Record<string, number> }) {
  const [market, setMarket] = useState<Market | null>(initial);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(25);
  const [open, setOpen] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/prices?limit=250", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `Something went wrong (${res.status}).`);
      else { setMarket(json as Market); setError(""); }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const first = initial ? undefined : setTimeout(() => void refresh(), 0); // not inside the effect itself: it sets state
    const t = setInterval(refresh, 60_000);
    return () => { clearInterval(t); if (first) clearTimeout(first); };
  }, [initial, refresh]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = market?.rows ?? [];
    return (needle ? all.filter((r) => r.symbol.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)) : all).slice(0, needle ? 250 : limit);
  }, [market, q, limit]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Search a coin or ticker" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search coins" />
        <button className="btn btn-ghost btn-sm" disabled={busy} aria-busy={busy} onClick={refresh}>Refresh</button>
        {market && <span className="text-xs" style={{ color: "var(--tx-2)" }}>From {market.source === "coinmarketcap" ? "CoinMarketCap" : "CoinGecko"}, {new Date(market.fetchedAt).toLocaleTimeString()}. Updates every minute.</span>}
      </div>
      {error && <p role="alert" className="shake mt-3 text-sm neg">{error}</p>}
      <div className="card mt-4 overflow-x-auto p-0">
        <table className="t">
          <thead><tr className="label"><th>#</th><th>Coin</th><th className="text-right">Price</th><th className="text-right">24h</th><th className="text-right">Market cap</th><th className="text-right">You hold</th></tr></thead>
          <tbody>
            {rows.flatMap((r) => [
              <tr key={`${r.rank}-${r.symbol}`} className="reveal">
                <td className="mono" style={{ color: "var(--tx-2)" }}>{r.rank}</td>
                <td><button className="text-left" aria-expanded={open === r.symbol} onClick={() => setOpen(open === r.symbol ? "" : r.symbol)} title="Show the price chart"><strong>{r.symbol}</strong> <span style={{ color: "var(--tx-1)" }}>{r.name}</span> <span aria-hidden style={{ color: "var(--tx-2)" }}>{open === r.symbol ? "▾" : "▸"}</span></button></td>
                <td className="amount text-right">{usd(r.priceUsd)}</td>
                <td className={`mono text-right ${r.change24h === null ? "" : r.change24h >= 0 ? "pos" : "neg"}`}>{r.change24h === null ? "–" : `${r.change24h >= 0 ? "▲" : "▼"} ${Math.abs(r.change24h).toFixed(2)}%`}</td>
                <td className="mono text-right" style={{ color: "var(--tx-1)" }}>{big(r.marketCapUsd)}</td>
                <td className="mono text-right">{holdings[r.symbol] ? `${holdings[r.symbol].toLocaleString(undefined, { maximumFractionDigits: 4 })} (${usd(holdings[r.symbol] * r.priceUsd)})` : ""}</td>
              </tr>,
              ...(open === r.symbol ? [<tr key={`${r.rank}-${r.symbol}-chart`}><td colSpan={6} className="p-0"><PriceChart symbol={r.symbol} /></td></tr>] : []),
            ])}
            {market && rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center" style={{ color: "var(--tx-1)" }}>No coin matches that.</td></tr>}
            {!market && !error && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={6}><div className="skeleton h-5 my-1" /></td></tr>)}
          </tbody>
        </table>
      </div>
      {!q && market && limit < market.rows.length && <div className="mt-3 text-center"><button className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + 50)}>Show more</button></div>}
    </div>
  );
}
