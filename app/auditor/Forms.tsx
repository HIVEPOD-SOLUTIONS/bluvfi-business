"use client";
import { useState } from "react";
import { ActionButton, ErrorLine, useAction } from "@/components/Actions";
import { Badge, usd } from "@/components/ui";

export function GrantForm() {
  const { run, error, loading } = useAction();
  const [grantee, setGrantee] = useState("");
  const [days, setDays] = useState("30");
  const [key, setKey] = useState<string | null>(null);
  return (
    <div className="mt-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run<{ viewKey: string }>("/api/audit/grant", { grantee, days: Number(days) });
          if (r) { setKey(r.viewKey); setGrantee(""); }
        }}
      >
        <label className="block"><span className="label">Grant to</span>
          <input className="input mt-1" required value={grantee} onChange={(e) => setGrantee(e.target.value)} placeholder="Auditor, Smith & Co" /></label>
        <label className="block"><span className="label">For (days)</span>
          <input className="input mt-1 w-24" type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={loading}>Create view key</button>
      </form>
      {key && (
        <div role="status" className="toast-in mt-3 rounded-xl p-3 text-sm" style={{ background: "var(--bg-2)" }}>
          Copy this key now. It is shown once and only its hash is stored.
          <div className="mono mt-1 break-all text-xs">{key}</div>
        </div>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}

export function GrantRow({ id, grantee, expiresAt, revoked }: { id: string; grantee: string; expiresAt: string; revoked: boolean }) {
  const expired = new Date(expiresAt) < new Date();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3" style={{ borderColor: "var(--bd)" }}>
      <div><div className="font-medium">{grantee}</div><div className="text-sm" style={{ color: "var(--tx-2)" }}>until {new Date(expiresAt).toLocaleDateString()}</div></div>
      <div className="flex items-center gap-2">
        <Badge tone={revoked ? "bad" : expired ? "default" : "ok"}>{revoked ? "Revoked" : expired ? "Expired" : "Active"}</Badge>
        {!revoked && <ActionButton url="/api/audit/revoke" payload={{ id }} variant="ghost" small>Revoke</ActionButton>}
      </div>
    </li>
  );
}

interface Rec { id: string; vendor: string; amountUsd: number; headline: string; recordHash: string }
export function OpenWithKey() {
  const { run, error, loading } = useAction();
  const [key, setKey] = useState("");
  const [out, setOut] = useState<{ grantee: string; records: Rec[] } | null>(null);
  return (
    <div>
      <h3>Open records with a view key</h3>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await run<{ grantee: string; records: Rec[] }>("/api/audit/open", { key }); setOut(r); }}>
        <input className="input min-w-0 flex-1" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste a view key" aria-label="View key" />
        <button className="btn btn-secondary" disabled={loading || !key}>Decrypt</button>
      </form>
      <ErrorLine msg={error} />
      {out && (
        <div className="mt-3 text-sm">
          <p style={{ color: "var(--tx-1)" }}>Decrypted for <strong>{out.grantee}</strong>: {out.records.length} record(s).</p>
          <ul className="mt-1 grid gap-1">{out.records.map((r) => <li key={r.id}>{r.vendor} · {usd(r.amountUsd)} · {r.headline}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
