"use client";
import { useEffect, useState } from "react";
import type { Chart as CryptoChart } from "@/lib/chart";

type Chart = Pick<CryptoChart, "days" | "points" | "changePct" | "high" | "low"> & { symbol?: string; asset?: string };

const RANGES: [number, string][] = [[1, "1D"], [7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"]];
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1 ? 2 : 6 });
const W = 640, H = 180;

/** A calm line chart of one coin's price over a chosen range. Plain SVG, no library; hover or touch shows the price at that moment. */
export function PriceChart({ symbol, kind = "crypto" }: { symbol: string; kind?: "crypto" | "stock" }) {
  const ranges = kind === "stock" ? RANGES.filter(([d]) => d !== 1) : RANGES;
  const [days, setDays] = useState(7);
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(kind === "stock" ? `/api/stocks?chart=${encodeURIComponent(symbol)}&days=${days}` : `/api/prices/chart?symbol=${encodeURIComponent(symbol)}&days=${days}`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) { setChart(null); setError(json.error ?? `Something went wrong (${res.status}).`); }
        else { setChart(json as Chart); setError(""); }
      } catch {
        if (live) { setChart(null); setError("Could not reach the server."); }
      }
    })();
    return () => { live = false; };
  }, [symbol, days, kind]);

  const shown = chart && (chart.symbol ?? chart.asset) === symbol && chart.days === days ? chart : null;
  let path = "", area = "", hover: { x: number; y: number; t: number; v: number } | null = null;
  if (shown) {
    const t0 = shown.points[0][0], t1 = shown.points[shown.points.length - 1][0];
    const span = shown.high - shown.low || 1;
    const xy = shown.points.map(([t, v]) => [((t - t0) / (t1 - t0 || 1)) * W, H - 8 - ((v - shown.low) / span) * (H - 16)] as const);
    path = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    area = `${path} L${W} ${H} L0 ${H} Z`;
    const i = at === null ? shown.points.length - 1 : Math.max(0, Math.min(shown.points.length - 1, at));
    hover = { x: xy[i][0], y: xy[i][1], t: shown.points[i][0], v: shown.points[i][1] };
  }
  const up = (shown?.changePct ?? 0) >= 0;
  const color = up ? "var(--pos, #1a7f4b)" : "var(--neg, #b3261e)";

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Chart range">
          {ranges.map(([d, label]) => <button key={d} className={`btn btn-sm ${d === days ? "btn-secondary" : "btn-ghost"}`} aria-pressed={d === days} onClick={() => { setDays(d); setAt(null); }}>{label}</button>)}
        </div>
        {shown && hover && (
          <div className="text-sm" style={{ color: "var(--tx-1)" }}>
            <span className="amount">{usd(hover.v)}</span> · {new Date(hover.t).toLocaleString(undefined, days <= 1 ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", year: days > 90 ? "numeric" : undefined })}
            {shown.changePct !== null && <span className={`mono ml-2 ${up ? "pos" : "neg"}`}>{up ? "▲" : "▼"} {Math.abs(shown.changePct).toFixed(2)}% over the range</span>}
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-3 text-sm neg">{error}</p>}
      {!shown && !error && <div className="skeleton mt-3" style={{ height: H }} />}
      {shown && hover && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" style={{ height: H, touchAction: "pan-y" }} role="img" aria-label={`${symbol} price, ${usd(shown.low)} to ${usd(shown.high)}`}
            onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(Math.round(((e.clientX - r.left) / r.width) * (shown.points.length - 1))); }}
            onPointerLeave={() => setAt(null)}>
            <path d={area} fill={color} opacity={0.1} />
            <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <line x1={hover.x} x2={hover.x} y1={0} y2={H} stroke="currentColor" opacity={0.2} />
            <circle cx={hover.x} cy={hover.y} r={4} fill={color} />
          </svg>
          <div className="mt-1 flex justify-between text-xs mono" style={{ color: "var(--tx-2)" }}><span>Low {usd(shown.low)}</span><span>High {usd(shown.high)}</span></div>
        </>
      )}
    </div>
  );
}
