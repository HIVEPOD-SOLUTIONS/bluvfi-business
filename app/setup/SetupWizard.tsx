"use client";
import { useCallback, useState } from "react";
import type { SetupPlan, SetupResult } from "@/lib/setup";
import { PrivyPayerButton, type Payer } from "./PrivyPayer";

type Wallet = { signAndSendTransactions(p: { network: string; signerId: string; transactions: SetupPlan["transactions"] }): Promise<unknown> };

export function SetupWizard({ network, needsCode, factory, pending, privyAppId, rpcUrl, costNear }: {
  network: "mainnet" | "testnet"; needsCode: boolean; factory: string; pending: SetupPlan | null; privyAppId: string; rpcUrl: string; costNear: number;
}) {
  const [code, setCode] = useState("");
  const [codeOk, setCodeOk] = useState(!needsCode);
  // Who pays and signs: a NEAR wallet, or a Privy email/Google login with its embedded NEAR wallet.
  const [payer, setPayer] = useState<Payer | null>(null);
  const [usingPrivy, setUsingPrivy] = useState(false);
  const account = payer?.accountId ?? "";
  const [form, setForm] = useState({ name: pending?.name ?? "", council: pending?.council.join("\n") ?? "", agent: pending?.agent ?? "" });
  const onPrivy = useCallback((p: Payer | null) => {
    setPayer(p);
    if (p) setForm((f) => ({ ...f, council: f.council || p.accountId }));
  }, []);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const suffix = network === "testnet" ? "testnet" : "near";

  async function call<T>(payload: object): Promise<T> {
    const r = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...(needsCode ? { "x-setup-code": code.trim() } : {}) },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j as T;
  }
  const step = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const checkCode = () => step("code", async () => {
    await call({ action: "check" });
    setCodeOk(true);
  });

  const connect = () => step("connect", async () => {
    const { NearConnector } = await import("@hot-labs/near-connect");
    const connector = new NearConnector({ network });
    const w = await connector.connect();
    const accounts = await w.getAccounts();
    if (!accounts.length) throw new Error("The wallet returned no account.");
    const id = accounts[0].accountId;
    setPayer({
      accountId: id,
      label: "wallet",
      send: async (transactions) => { await (w as unknown as Wallet).signAndSendTransactions({ network, signerId: id, transactions }); },
    });
    setForm((f) => ({ ...f, council: f.council || id }));
  });

  const check = () => step("plan", async () => {
    const council = form.council.split(/[\s,]+/).filter(Boolean);
    const { plan } = await call<{ plan: SetupPlan }>({ action: "plan", funder: account, council, name: form.name, agent: form.agent || undefined });
    setPlan(plan);
  });

  const signAndFinish = () => step("sign", async () => {
    if (!plan) return;
    if (plan.transactions.length) {
      if (!payer) throw new Error("Connect a wallet or sign in first.");
      await payer.send(plan.transactions);
    }
    const { result } = await call<{ result: SetupResult }>({ action: "finish" });
    setResult(result);
  });

  if (result) {
    return (
      <div className="mt-4 grid gap-3">
        <p className="pos"><strong>Done.</strong> Treasury <span className="mono">{result.dao}</span>, agent <span className="mono">{result.agent}</span>.</p>
        <ul className="grid gap-1 text-sm">{result.done.map((d) => <li key={d}><span className="pos mono">✓</span> {d}</li>)}</ul>
        {result.signers && (
          <div className="card" style={{ borderColor: "rgba(232,168,56,.5)" }}>
            <p className="text-sm"><strong>Your signer tokens, shown once.</strong> Copy them now; you sign in with them. They are also in <span className="mono">.env.local</span>.</p>
            <ul className="mt-2 grid gap-1 text-sm mono">{result.signers.map((s) => <li key={s.name}>{s.name}: {s.token}</li>)}</ul>
          </div>
        )}
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>
          Restart the app (<span className="mono">npm run dev</span>) so it loads the new settings, then sign in and open the Overview: &quot;Who can move the money&quot; reads all of this back from the chain.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-4">
      {needsCode && (
        <section>
          <h2 className="text-base">1. Setup code</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>No signers exist yet, so setup needs the one-time code printed in the terminal running the app.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="input" style={{ maxWidth: 220 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="setup code" aria-label="Setup code" disabled={codeOk} />
            {!codeOk && <button className="btn btn-primary" onClick={checkCode} disabled={!!busy || !code.trim()}>{busy === "code" ? "Checking…" : "Continue"}</button>}
            {codeOk && <span className="pos text-sm self-center">✓ Code accepted</span>}
          </div>
        </section>
      )}

      {codeOk && (
        <section>
          <h2 className="text-base">{needsCode ? "2" : "1"}. Choose how to pay</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
            A NEAR {network} wallet, or {privyAppId ? "your email or Google account (Privy keeps a NEAR wallet for you)" : "email or Google once PRIVY_APP_ID is set"}. It signs the account and DAO creation; nothing else.
          </p>
          <div className="mt-2 flex flex-wrap items-start gap-3">
            {payer && !usingPrivy ? (
              <span className="pos text-sm">✓ Connected as <span className="mono">{account}</span></span>
            ) : !usingPrivy ? (
              <>
                <button className="btn btn-primary" onClick={connect} disabled={!!busy}>{busy === "connect" ? "Opening wallet…" : "Connect wallet"}</button>
                {privyAppId && <button className="btn btn-secondary" onClick={() => setUsingPrivy(true)} disabled={!!busy}>Use email or Google</button>}
              </>
            ) : null}
            {usingPrivy && privyAppId && <PrivyPayerButton appId={privyAppId} network={network} rpcUrl={rpcUrl} needNear={Math.ceil(costNear + 0.5)} onReady={onPrivy} />}
          </div>
        </section>
      )}

      {account && (
        <section className="grid gap-3">
          <h2 className="text-base">{needsCode ? "3" : "2"}. Describe the treasury</h2>
          <label className="block"><span className="label">Treasury name</span>
            <input className="input mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder="acme" />
            <span className="text-xs" style={{ color: "var(--tx-2)" }}>Becomes <span className="mono">{form.name || "acme"}.{factory}</span></span></label>
          <label className="block"><span className="label">Council (one account per line, at least two)</span>
            <textarea className="input mt-1" rows={3} value={form.council} onChange={(e) => setForm({ ...form, council: e.target.value })} placeholder={`you.${suffix}\npartner.${suffix}`} />
            <span className="text-xs" style={{ color: "var(--tx-2)" }}>These accounts approve payments in Trezu. A majority executes a payout.</span></label>
          <label className="block"><span className="label">Agent account (new name)</span>
            <input className="input mt-1" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value.toLowerCase() })} placeholder={`${form.name || "acme"}-agent.${suffix}`} />
            <span className="text-xs" style={{ color: "var(--tx-2)" }}>Leave empty for the default. It will only ever be able to propose payments.</span></label>
          <div><button className="btn btn-secondary" onClick={check} disabled={!!busy || !form.name}>{busy === "plan" ? "Checking the chain…" : "Check the plan"}</button></div>
        </section>
      )}

      {plan && (
        <section className="card" style={{ borderColor: "var(--bd-sage)" }}>
          <h2 className="text-base">{needsCode ? "4" : "3"}. Review and sign</h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {plan.steps.map((s) => <li key={s.label}><span className={s.done ? "pos mono" : "mono"}>{s.done ? "✓" : "•"}</span> {s.label}{s.done ? " (already done)" : ""}</li>)}
          </ul>
          <p className="mt-2 text-sm" style={{ color: "var(--tx-1)" }}>
            Council: {plan.council.join(", ")}, executing on {plan.votes} of {plan.council.length}. {usingPrivy ? "Privy signs" : "Your wallet signs"} {plan.transactions.length} transaction{plan.transactions.length === 1 ? "" : "s"}, moving about {plan.costNear} NEAR{plan.network === "mainnet" ? " of real money" : " (testnet)"}.
          </p>
          <div className="mt-3"><button className="btn btn-primary" onClick={signAndFinish} disabled={!!busy}>{busy === "sign" ? (usingPrivy ? "Signing with Privy…" : "Waiting for your wallet…") : plan.transactions.length ? (usingPrivy ? "Sign with Privy and finish" : "Sign in wallet and finish") : "Finish setup"}</button></div>
        </section>
      )}

      {error && <p role="alert" className="text-sm neg">{error}</p>}
    </div>
  );
}
