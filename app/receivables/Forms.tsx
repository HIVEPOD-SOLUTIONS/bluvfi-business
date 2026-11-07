"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";

export function NewReceivable() {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({ client: "", description: "", amountUsd: "" });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run("/api/receivables", { ...f, amountUsd: Number(f.amountUsd) });
        if (ok) setF({ client: "", description: "", amountUsd: "" });
      }}
    >
      <label className="block"><span className="label">Client</span>
        <input className="input mt-1" required value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} placeholder="Orbit Labs" /></label>
      <label className="block"><span className="label">For</span>
        <input className="input mt-1" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Q4 retainer" /></label>
      <label className="block"><span className="label">Amount (USD)</span>
        <input className="input mt-1" required type="number" min="1" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} placeholder="3000" /></label>
      <div className="sm:col-span-3"><button className="btn btn-primary" disabled={loading} aria-busy={loading}>{loading ? "Creating…" : "Create invoice and link"}</button><ErrorLine msg={error} /></div>
    </form>
  );
}

export function CopyLink({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="mono min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-xs" style={{ background: "var(--bg-2)" }}>{path}</code>
      <button
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${window.location.origin}${path}`);
            setDone(true);
            setTimeout(() => setDone(false), 1800);
          } catch {
            window.prompt("Copy this link", `${window.location.origin}${path}`);
          }
        }}
      >{done ? "Copied ✓" : "Copy link"}</button>
      <a className="btn btn-ghost btn-sm" href={path}>Open</a>
    </div>
  );
}
