"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge, VERDICT } from "@/components/ui";
import type { CheckResponse } from "@/lib/types";

export function Playground({ biz = "" }: { biz?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ payoutAddress: "", vendorName: "", vendorDomain: "", chain: "eth", invoiceText: "" });
  const [res, setRes] = useState<CheckResponse | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setRes(null); setError(null); setLoading(true);
    try {
      // The website uses the free, rate-limited tier. Agents call the paid /api/check.
      const r = await fetch(`/api/check/try${biz ? `?b=${biz}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
      const j = await r.json();
      if (r.ok) setRes(j); else setError(j.error ?? `Failed (${r.status})`);
    } catch { setError("Could not reach the server."); } finally { setLoading(false); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Try a check</h2>
      <div className="mt-3 grid gap-3">
        <label className="block"><span className="label">Payout address</span><input className="input mt-1" required value={f.payoutAddress} onChange={set("payoutAddress")} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Vendor name</span><input className="input mt-1" value={f.vendorName} onChange={set("vendorName")} /></label>
          <label className="block"><span className="label">Vendor domain</span><input className="input mt-1" value={f.vendorDomain} onChange={set("vendorDomain")} /></label>
        </div>
        <label className="block"><span className="label">Invoice text (optional)</span><textarea className="input mt-1" value={f.invoiceText} onChange={set("invoiceText")} placeholder="Paste text to scan for hidden instructions" /></label>
        <button className="btn btn-primary w-fit" disabled={loading}>{loading ? "Checking…" : "Check this payee"}</button>
      </div>
      <ErrorLine msg={error} />
      {res && (
        <div className="toast-in mt-4" role="status">
          <Badge tone={VERDICT[res.verdict].tone}>{VERDICT[res.verdict].icon} {res.verdict.toUpperCase()}</Badge>
          <ul className="mt-2 grid gap-1 text-sm">
            {res.checks.map((c) => <li key={c.id}><span className={c.verdict === "allow" ? "pos" : c.verdict === "warn" ? "" : "neg"} style={c.verdict === "warn" ? { color: "var(--amber)" } : undefined}>{VERDICT[c.verdict].icon}</span> <strong>{c.label}:</strong> <span style={{ color: "var(--tx-1)" }}>{c.reason}</span></li>)}
          </ul>
        </div>
      )}
    </form>
  );
}

export function ReportForm() {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({ kind: "address", value: "", reason: "", evidence: "" });
  const [done, setDone] = useState(false);
  return (
    <form className="card" onSubmit={async (e) => { e.preventDefault(); setDone(false); const r = await run("/api/report", { ...f, reportedBy: "agent:website" }); if (r) { setDone(true); setF({ ...f, value: "", reason: "", evidence: "" }); } }}>
      <h2>Report fraud</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Confirmed a scam? Add it, with evidence, so every other agent is warned.</p>
      <div className="mt-3 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind"><option>address</option><option>domain</option></select>
          <input className="input" required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="Address or domain" aria-label="Value" />
        </div>
        <input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="What happened" aria-label="Reason" />
        <textarea className="input" required value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} placeholder="Evidence (only its hash is published)" aria-label="Evidence" />
        <button className="btn btn-secondary w-fit" disabled={loading}>Add to blocklist</button>
      </div>
      <ErrorLine msg={error} />
      {done && <p role="status" className="mt-2 text-sm pos">Added. Thank you.</p>}
    </form>
  );
}

export function SpendDemo() {
  const { run, error, loading } = useAction();
  const [url, setUrl] = useState("");
  const [out, setOut] = useState<{ ok: boolean; note?: string; priceUsd?: number; body?: unknown } | null>(null);
  return (
    <div className="card">
      <h2>Agent buys an API (x402)</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>The agent hits a paywall, gets HTTP 402, pays under the same policy and kill switch, and reads the data. Crypto-native answer to agent cards.</p>
      <input className="input mt-3" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/paid-endpoint" aria-label="Paywalled API URL" />
      <button className="btn btn-secondary mt-3" disabled={loading || !url} onClick={async () => setOut(await run("/api/x402/spend", { url }))}>{loading ? "Buying…" : "Buy one call"}</button>
      <ErrorLine msg={error} />
      {out && (
        <div className="toast-in mt-3 text-sm" role="status">
          <Badge tone={out.ok ? "ok" : "bad"}>{out.ok ? "Bought" : "Refused"}</Badge>
          <p className="mt-1" style={{ color: "var(--tx-1)" }}>{out.note}{out.priceUsd ? ` Price $${out.priceUsd}.` : ""}</p>
          {out.body != null && <pre className="mono mt-2 overflow-auto rounded-lg p-2 text-xs" style={{ background: "var(--bg-2)" }}>{JSON.stringify(out.body)}</pre>}
        </div>
      )}
    </div>
  );
}
