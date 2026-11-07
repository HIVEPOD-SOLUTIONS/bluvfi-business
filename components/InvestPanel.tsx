"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import type { AllocationPreview, Holding, InvestAsset } from "@/lib/invest";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1 ? 2 : 4 });

/** Choose a coin and an amount, see what it would buy right now, and propose it. The council's rules and the treasury's approval still decide. */
export function InvestPanel({ assets, allowed, holdings }: { assets: InvestAsset[]; allowed: { assets: string[]; maxUsd: number }; holdings: Holding[] }) {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const open = allowed.assets.length > 0 && allowed.maxUsd > 0;
  const first = assets.find((a) => allowed.assets.includes(a.symbol))?.symbol ?? assets[0]?.symbol ?? "";
  const [symbol, setSymbol] = useState(first);
  const [amount, setAmount] = useState("100");
  const [preview, setPreview] = useState<AllocationPreview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = allowed.assets.includes(symbol) && Number(amount) <= allowed.maxUsd;

  async function look() {
    setBusy(true); setErr(""); setPreview(null);
    try {
      const res = await fetch("/api/invest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview: true, symbol, amountUsd: Number(amount) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setErr(json.error ?? `Something went wrong (${res.status}).`); else setPreview(json.preview);
    } catch { setErr("Could not reach the server."); } finally { setBusy(false); }
  }

  const total = holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0);
  return (
    <div className="grid gap-4">
      {!open && (
        <div className="card" style={{ borderColor: "rgba(232,168,56,.4)" }}>
          <h2>Investing is off</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Your council decides whether the treasury may invest, and in which coins, in the policy. Until it does, nothing can be proposed here. <Link className="underline" href="/policy">Open the policy</Link></p>
        </div>
      )}
      <div className="card">
        <h2>Put some of the treasury into a coin</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>The treasury swaps USDC into the coin, and the coin lands in the treasury&apos;s own account. Nobody else holds it. {open && <>You may invest {allowed.assets.join(", ")}, up to {usd(allowed.maxUsd)} at a time.</>}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block"><span className="label">Coin</span>
            <select className="input mt-1" value={symbol} onChange={(e) => { setSymbol(e.target.value); setPreview(null); }}>
              {assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol} · {a.name} · {usd(a.priceUsd)}{allowed.assets.includes(a.symbol) ? "" : " (not allowed)"}</option>)}
            </select></label>
          <label className="block"><span className="label">How much USDC</span>
            <input className="input mt-1" type="number" min="10" step="10" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} /></label>
          <div className="flex items-end"><button className="btn btn-secondary w-full" disabled={busy || !(Number(amount) >= 10)} aria-busy={busy} onClick={look}>See what it buys</button></div>
        </div>
        {preview && (
          <p className="reveal mt-3">About <strong className="amount">{preview.youGet.toLocaleString(undefined, { maximumSignificantDigits: 6 })} {preview.symbol}</strong>, worth {usd(preview.worthUsd)} now. Cost of the swap: about {preview.costPct.toFixed(2)}%. <span className="text-sm" style={{ color: "var(--tx-2)" }}>The final amount is set when it is sent.</span></p>
        )}
        <ErrorLine msg={err} />
        <button className="btn btn-primary mt-3" disabled={loading || !open || !ok || !preview} aria-busy={loading} onClick={async () => {
          const r = await run<{ payment: { id: string } }>("/api/invest", { symbol, amountUsd: Number(amount) }, "POST", "Investment proposed: now it needs approval");
          if (r) router.push(`/payments/${r.payment.id}`);
        }}>Propose this investment</button>
        {open && !ok && <span className="ml-3 text-sm neg">{!allowed.assets.includes(symbol) ? `${symbol} is not on the council's list.` : `That is over the ${usd(allowed.maxUsd)} limit.`}</span>}
        <ErrorLine msg={error} />
      </div>

      <div className="card overflow-x-auto p-0">
        <div className="flex items-center justify-between p-4 pb-2"><h2>What the treasury holds in other coins</h2><span className="amount">{usd(total)}</span></div>
        <table className="t">
          <thead><tr className="label"><th>Coin</th><th className="text-right">Amount</th><th className="text-right">Price</th><th className="text-right">Worth</th></tr></thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.tokenId} className="reveal">
                <td><strong>{h.symbol}</strong> <span style={{ color: "var(--tx-1)" }}>{h.name}</span></td>
                <td className="mono text-right">{h.amount.toLocaleString(undefined, { maximumSignificantDigits: 8 })}</td>
                <td className="mono text-right">{h.priceUsd ? usd(h.priceUsd) : "–"}</td>
                <td className="amount text-right">{h.valueUsd ? usd(h.valueUsd) : "–"}</td>
              </tr>
            ))}
            {holdings.length === 0 && <tr><td colSpan={4} className="py-6 text-center" style={{ color: "var(--tx-1)" }}>Nothing yet. Once an investment goes through, the coin shows up here.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-sm" style={{ color: "var(--tx-2)" }}>Selling back to USDC, or moving a coin out to another chain, is not in this app yet: the council can do both from the treasury&apos;s NEAR Intents account.</p>
    </div>
  );
}
