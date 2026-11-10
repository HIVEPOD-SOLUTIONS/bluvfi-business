"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";

/** Paste or choose a CSV. It is only read and checked here; sending it to the council is a separate, explicit step. */
export function PayrollUpload({ sample }: { sample: string }) {
  const { run, error, loading } = useAction();
  const [csv, setCsv] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState("");
  return (
    <form
      className="card grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run("/api/payroll", { action: "upload", csv, title }, "POST", "Checked: review it below")) {
          setCsv("");
          setFile("");
        }
      }}
    >
      <h2>Upload a payroll sheet</h2>
      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
        One line per person: <span className="mono">name,amount,chain,asset,address</span>. Amounts in USD. Chains: NEAR, Ethereum, Base, Arbitrum, Solana; each person picks their own chain and stablecoin. Nothing is sent yet: every line is checked first.
      </p>
      <label className="block"><span className="label">Name of this run</span>
        <input className="input mt-1" value={title} maxLength={80} placeholder="November salaries" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block"><span className="label">CSV file</span>
        <input
          className="input mt-1" type="file" accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFile(f.name);
            setCsv(await f.text());
          }}
        />
      </label>
      <label className="block"><span className="label">Or paste it {file && <span style={{ color: "var(--tx-2)" }}>(read from {file})</span>}</span>
        <textarea className="input mt-1 mono text-xs" rows={6} value={csv} placeholder={sample} onChange={(e) => setCsv(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={loading || !csv.trim()} aria-busy={loading}>{loading ? "Checking…" : "Check this payroll"}</button>
        <button type="button" className="btn btn-ghost" onClick={() => setCsv(sample)}>Use the example</button>
        <a className="btn btn-ghost" download="payroll-example.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`}>Download the example</a>
      </div>
      <ErrorLine msg={error} />
    </form>
  );
}
