"use client";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui";

interface Verdict {
  valid: boolean;
  kind: string;
  statement: Record<string, string>;
  issuers?: string[];
  threshold?: number;
  problems: string[];
  createdAt?: string;
  issuerIsThisApp?: boolean;
  distinctIssuers?: number;
  listRootIsPublishedHere?: boolean;
}

const short = (s: string, n = 14) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const money = (cents: string) => `$${(Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const day = (secs: string) => new Date(Number(secs) * 1000).toLocaleString();

/** What the proof proves, in words, from the statement decoded out of the proof itself. */
function sentence(v: Verdict): string {
  const s = v.statement;
  switch (v.kind) {
    case "sanctions": return "A payee address is not on the OFAC sanctions list whose root is shown below. The address is not revealed.";
    case "name": return "A vendor name (exact match, after normalising) is not among the names and aliases on the OFAC sanctions list whose root is shown below. The name is not revealed.";
    case "vendor": return `A vendor passed identity verification, as attested by ${v.threshold ?? 1} different issuer(s). Which vendor is not revealed. Valid as of ${s.asOf ? day(s.asOf) : "the time shown"}.`;
    case "business": return `A business passed identity verification, as attested by ${v.threshold ?? 1} different issuer(s). Which business is not revealed. Valid as of ${s.asOf ? day(s.asOf) : "the time shown"}.`;
    case "solvency": return `A treasury held at least ${money(s.minTotalCents)} at a balance snapshot taken within ${Math.round(Number(s.maxAgeSeconds) / 3600)} hours of ${s.asOf ? day(s.asOf) : "the time shown"}, as attested by ${v.threshold ?? 1} different issuer(s). No balance or account is revealed.`;
    case "circuit": return `A secret quantum circuit, committed to below, uses at most ${s.maxQubits} qubits and ${s.maxToffoli} Toffoli gates. No gate is revealed.`;
    default: return "Unknown kind of proof.";
  }
}

/** Check a proof file, on the page: paste it or choose the file, and see what it proves and whether to believe it. */
export function ProofChecker() {
  const [text, setText] = useState("");
  const [issuer, setIssuer] = useState("");
  const [need, setNeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Verdict | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function check() {
    setError(""); setResult(null);
    let artifact: unknown;
    try { artifact = JSON.parse(text); } catch { setError("That is not a proof file: it should be the JSON file you were given."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/claims/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact, expect: { trustedIssuer: issuer, minThreshold: need ? Number(need) : undefined } }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `Something went wrong (${res.status}).`);
      else setResult(json as Verdict);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="card">
        <label className="label" htmlFor="proof">Proof file</label>
        <textarea id="proof" className="input mono mt-1 text-xs" rows={8} placeholder='Paste the contents of the proof file, or choose it below. It starts with {"version":1,"kind":…' value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input ref={file} type="file" accept="application/json,.json" className="text-sm" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 2_000_000) { setError("That file is too large to be a proof."); return; }
            setText(await f.text());
            setResult(null); setError("");
          }} />
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer" style={{ color: "var(--tx-2)" }}>What I require (optional)</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block"><span className="label">An issuer I trust (public key)</span>
              <input className="input mono mt-1 text-xs" placeholder="B62q…" value={issuer} onChange={(e) => setIssuer(e.target.value)} /></label>
            <label className="block"><span className="label">At least this many different issuers</span>
              <input className="input mt-1" type="number" min="1" max="3" value={need} onChange={(e) => setNeed(e.target.value)} /></label>
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--tx-2)" }}>If you set an issuer, every issuer the proof names must be that one. Leave both empty to see who the proof names and decide yourself.</p>
        </details>
        <button className="btn btn-primary mt-3" disabled={busy || !text.trim()} onClick={check}>{busy ? "Checking…" : "Check this proof"}</button>
        {error && <p role="alert" className="mt-2 text-sm neg">{error}</p>}
      </div>

      {result && (
        <div className="card" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.valid ? "ok" : "bad"}>{result.valid ? "Proof is valid" : "Do not rely on this proof"}</Badge>
            <span className="mono text-sm">{result.kind}</span>
            {result.createdAt && <span className="text-sm" style={{ color: "var(--tx-2)" }}>made {new Date(result.createdAt).toLocaleString()}</span>}
          </div>
          {result.valid && <p className="mt-3">{sentence(result)}</p>}
          {result.problems.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-sm neg">{result.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {result.issuers && <><dt style={{ color: "var(--tx-2)" }}>Issuers named</dt><dd className="mono break-all">{[...new Set(result.issuers)].map((k) => short(k)).join(", ")} ({result.distinctIssuers} different; {result.threshold} must sign)</dd></>}
            {result.issuerIsThisApp !== undefined && <><dt style={{ color: "var(--tx-2)" }}>This app is an issuer</dt><dd>{result.issuerIsThisApp ? "Yes" : "No: it was attested by others, so check you trust them"}</dd></>}
            {result.statement.listRoot && <><dt style={{ color: "var(--tx-2)" }}>OFAC list root</dt><dd className="mono break-all">{short(result.statement.listRoot, 18)}{result.listRootIsPublishedHere === false ? " (not one this app has published: check it against OFAC's list)" : " (published by this app)"}</dd></>}
            {result.statement.circuitCommitment && <><dt style={{ color: "var(--tx-2)" }}>Circuit commitment</dt><dd className="mono break-all">{short(result.statement.circuitCommitment, 18)}</dd></>}
            {result.statement.subject && <><dt style={{ color: "var(--tx-2)" }}>About (subject)</dt><dd className="mono break-all">{short(result.statement.subject, 18)}</dd></>}
          </dl>
          <p className="mt-3 text-xs" style={{ color: "var(--tx-2)" }}>The statement above is read out of the proof itself, not from the file&apos;s own description. A valid proof says the claim is true given its issuers and list; it is only as trustworthy as they are.</p>
        </div>
      )}
    </div>
  );
}
