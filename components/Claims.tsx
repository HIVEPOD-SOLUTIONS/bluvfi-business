"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";

export interface ClaimRow { id: string; kind: string; label: string; createdAt: string; status: "proving" | "done" | "failed"; error?: string }

const sample = `[{"kind":1,"a":0},{"kind":2,"a":0,"b":1},{"kind":3,"a":0,"b":1,"c":2}]`;

/** Ask for a claim (sanctions, verified vendor or business, solvency, circuit) and see the ones made. */
export function ClaimForms({ vendors, kybOn }: { vendors: string[]; kybOn: boolean }) {
  const { run, error, loading } = useAction();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [vendor, setVendor] = useState(vendors[0] ?? "");
  const [minUsd, setMinUsd] = useState("10000");
  const [gates, setGates] = useState(sample);
  const [bounds, setBounds] = useState({ q: "3", t: "1" });
  const [formError, setFormError] = useState("");
  const go = async (payload: Record<string, unknown>) => { setFormError(""); await run("/api/claims", payload); };
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="card">
        <h2>Payee is not sanctioned</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Proves an address is not on the OFAC list, without saying which address. Anyone can check it against the list&apos;s public root.</p>
        <input className="input mt-2" placeholder="0x… or account address" value={address} onChange={(e) => setAddress(e.target.value)} />
        <button className="btn btn-primary btn-sm mt-2" disabled={loading || !address.trim()} onClick={() => go({ kind: "sanctions", address })}>Prove it</button>
      </div>
      <div className="card">
        <h2>Vendor name is not sanctioned</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Proves an exact (normalised) name is not among the OFAC list&apos;s names and aliases, without saying the name. A name one letter off a listed one is not covered: ordinary screening still warns on those.</p>
        <input className="input mt-2" placeholder="Vendor name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary btn-sm mt-2" disabled={loading || !name.trim()} onClick={() => go({ kind: "name", name })}>Prove it</button>
      </div>
      <div className="card">
        <h2>Verified business</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Proves a party passed identity verification, attested by this app, without saying who or sharing documents.</p>
        {kybOn ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <select className="input" value={vendor} onChange={(e) => setVendor(e.target.value)}>{vendors.map((v) => <option key={v}>{v}</option>)}</select>
            <button className="btn btn-primary btn-sm" disabled={loading || !vendor} onClick={() => go({ kind: "vendor", vendor })}>For this vendor</button>
            <button className="btn btn-secondary btn-sm" disabled={loading} aria-busy={loading} onClick={() => go({ kind: "business" })}>For our business</button>
          </div>
        ) : <p className="mt-2 text-sm">Identity verification is not set up (Persona), so there is nothing to attest.</p>}
      </div>
      <div className="card">
        <h2>Treasury is solvent</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Proves the treasury held at least an amount, from a balance the app read from the chain and signed, without showing any balance.</p>
        <div className="mt-2 flex gap-2"><input className="input" type="number" min="1" value={minUsd} onChange={(e) => setMinUsd(e.target.value)} /><button className="btn btn-primary btn-sm" disabled={loading} aria-busy={loading} onClick={() => go({ kind: "solvency", minUsd: Number(minUsd) })}>Prove at least this (USD)</button></div>
      </div>
      <div className="card">
        <h2>Secret circuit, bounded</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Proves a hidden circuit uses at most so many qubits and Toffoli gates, like a vulnerability disclosure, without showing a single gate. Up to 2,048 gates, proved a chunk at a time (about a quarter of a minute each); kind 1 is one qubit, 2 is two, 3 is Toffoli.</p>
        <textarea className="input mono mt-2 text-xs" rows={3} value={gates} onChange={(e) => setGates(e.target.value)} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-sm">At most qubits <input className="input w-20" type="number" min="0" value={bounds.q} onChange={(e) => setBounds({ ...bounds, q: e.target.value })} /></label>
          <label className="text-sm">Toffoli <input className="input w-20" type="number" min="0" value={bounds.t} onChange={(e) => setBounds({ ...bounds, t: e.target.value })} /></label>
          <button className="btn btn-primary btn-sm" disabled={loading} aria-busy={loading} onClick={() => {
            let parsed: unknown;
            try { parsed = JSON.parse(gates); } catch { setFormError("The gates must be JSON, like the example."); return; }
            void go({ kind: "circuit", gates: parsed, maxQubits: Number(bounds.q), maxToffoli: Number(bounds.t) });
          }}>Prove the bounds</button>
        </div>
      </div>
      <div className="md:col-span-2"><ErrorLine msg={formError || error} /></div>
    </div>
  );
}

/** The issuer set: this app plus any independent attesters, how many must sign, and whether the DAO's council has approved that set on chain. */
export function AnchorBox({ attesters, threshold }: { attesters: number; threshold: number }) {
  const { run, error, loading } = useAction();
  const [info, setInfo] = useState<{ anchored: boolean; status?: string; proposalId?: number } | null>(null);
  const check = async () => { const r = await run<{ anchor: { anchored: boolean; status?: string; proposalId?: number } }>("/api/claims", { kind: "anchor-status" }); if (r) setInfo(r.anchor); };
  return (
    <div className="card">
      <p className="text-sm">Credentials and balances are signed by this app{attesters ? ` and ${attesters} independent attester(s)` : ""}. <strong>{Math.min(threshold, attesters + 1)} different issuer(s) must sign</strong> before such a proof is made.
        {attesters === 0 && " No independent attester is set up (ZK_ATTESTERS), so this app alone is trusted."}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-secondary btn-sm" disabled={loading} aria-busy={loading} onClick={check}>Is this set approved on chain?</button>
        <button className="btn btn-secondary btn-sm" disabled={loading} aria-busy={loading} onClick={async () => { await run("/api/claims", { kind: "anchor" }); await check(); }}>Put this set to the DAO</button>
        {info && <Badge tone={info.anchored ? "ok" : "warn"}>{info.anchored ? `Approved by the council (proposal #${info.proposalId})` : info.status ?? "Not approved"}</Badge>}
      </div>
      <ErrorLine msg={error} />
    </div>
  );
}

/** The claims made, refreshing while any is still being proved. */
export function ClaimList({ claims }: { claims: ClaimRow[] }) {
  const router = useRouter();
  const pending = claims.some((c) => c.status === "proving");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [pending, router]);
  return (
    <div className="grid gap-2">
      {claims.map((c) => (
        <div key={c.id} className="card flex flex-wrap items-center justify-between gap-3">
          <div>
            <div>{c.label}</div>
            <div className="mono text-xs" style={{ color: "var(--tx-2)" }}>{c.id} · {new Date(c.createdAt).toLocaleString()}</div>
            {c.error && <div className="text-sm neg">{c.error}</div>}
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={c.status === "done" ? "ok" : c.status === "failed" ? "bad" : "warn"} live={c.status === "proving"}>{c.status === "done" ? "Proof ready" : c.status === "failed" ? "Failed" : "Proving…"}</Badge>
            {c.status === "done" && <a className="btn btn-secondary btn-sm" href={`/api/claims/${c.id}?download=1`}>Download proof</a>}
          </div>
        </div>
      ))}
    </div>
  );
}
