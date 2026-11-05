"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui";
import type { WalletStatus } from "@/lib/wallets";

export function WalletsPanel({ wallets }: { wallets: WalletStatus[] }) {
  return <div className="grid gap-4">{wallets.map((w) => <WalletCard key={w.id} w={w} />)}</div>;
}

type Action = "create" | "encrypt" | "token";

function WalletCard({ w }: { w: WalletStatus }) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");

  async function submit() {
    if (!open) return;
    if (open === "create" && pass !== confirm) return setError("The two passphrases differ.");
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: open, id: w.id, passphrase: pass }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      if (open === "token") setToken(j.token);
      setOpen(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPass("");
      setConfirm("");
      setBusy(false);
    }
  }

  const start = (a: Action) => { setOpen(a); setError(""); setPass(""); setConfirm(""); };
  const status = !w.exists
    ? <Badge tone="default">Not created</Badge>
    : w.sealed ? <Badge tone="ok">Key encrypted ✓</Badge> : <Badge tone={w.mustSeal ? "bad" : "warn"}>Key in plain text</Badge>;

  return (
    <section className="card" style={{ borderColor: w.exists && !w.sealed && w.mustSeal ? "rgba(224,82,82,.45)" : "var(--bd)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>{w.label}</h2>
        {status}
      </div>
      <p className="mt-1 text-xs mono" style={{ color: "var(--tx-2)" }}>{w.file}</p>

      {w.exists && (
        <ul className="mt-3 grid gap-1 text-sm">
          <li>Address: <span className="mono break-all">{w.address ?? "unknown until it is opened once with its passphrase"}</span></li>
          {w.balance && <li>Balance: {w.balance.amount === null ? "could not be read" : `${w.balance.amount.toFixed(w.balance.unit === "USDC" ? 6 : 4)} ${w.balance.unit}`}</li>}
          {w.kind === "payer" && w.caps && <li>Spent today: ${w.spentToday?.toFixed(4) ?? "0"} of ${w.caps.perDay} (at most ${w.caps.perPayment} per payment)</li>}
        </ul>
      )}
      {w.exists && !w.sealed && (
        <p className="mt-2 text-sm" style={{ color: w.mustSeal ? "var(--red-alert)" : "var(--amber)" }}>
          Anyone who can read this file controls the wallet. Encrypt it now{w.mustSeal ? "; mainnet keys are refused in plain text" : ""}.
        </p>
      )}
      {w.kind === "payer" && w.exists && (
        <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>
          {w.net === "mainnet" ? "Fund it with a few dollars of USDC on Base: that is the most it can ever lose." : "Free test USDC: faucet.circle.com, Base Sepolia."} The payer signs in its own process:
          <span className="mono"> BLUVFI_KEYFILE_PASSPHRASE=… npm run x402:payer -- serve{w.net === "mainnet" ? " --mainnet" : ""}</span>, with its token in .env.local as X402_PAYER_TOKEN.
        </p>
      )}
      {w.kind === "confidential" && w.exists && (
        <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>
          Its steps move real money, so they stay in the terminal: <span className="mono">npm run confidential:test -- status</span> (then register, deposit, shield, pay).
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!w.exists && <button className="btn btn-primary btn-sm" onClick={() => start("create")}>Create wallet</button>}
        {w.exists && !w.sealed && <button className="btn btn-primary btn-sm" onClick={() => start("encrypt")}>Encrypt the key</button>}
        {w.exists && w.kind === "payer" && <button className="btn btn-secondary btn-sm" onClick={() => start("token")}>Show the payer&apos;s token</button>}
      </div>

      {open && (
        <form className="mt-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label className="block"><span className="label">{open === "create" ? "Choose a passphrase (12+ characters)" : open === "encrypt" ? "Choose a passphrase to encrypt it with (12+ characters)" : "Passphrase"}</span>
            <input className="input mt-1" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus /></label>
          {open === "create" && (
            <label className="block"><span className="label">The same passphrase again</span>
              <input className="input mt-1" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          )}
          {open !== "token" && <p className="text-xs" style={{ color: "var(--tx-2)" }}>Keep it somewhere safe. It is not stored anywhere, and without it the key cannot be opened again.</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy || !pass}>{busy ? "Working…" : open === "create" ? "Create" : open === "encrypt" ? "Encrypt" : "Show token"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-sm neg">{error}</p>}
      {token && (
        <div className="mt-3 text-sm">
          <p>Put this in <span className="mono">.env.local</span> as <span className="mono">X402_PAYER_TOKEN</span>, then hide it:</p>
          <p className="mono mt-1 break-all rounded-lg p-2" style={{ background: "var(--bg-2)" }}>{token}</p>
          <button className="btn btn-ghost btn-sm mt-1" onClick={() => setToken("")}>Hide</button>
        </div>
      )}
    </section>
  );
}
