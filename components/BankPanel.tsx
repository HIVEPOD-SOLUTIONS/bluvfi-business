"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import type { BankAccount, BankPair } from "@/lib/banking";

type Setup = { configured: false } | { configured: true; on: BankPair[]; off: BankPair[]; accounts: BankAccount[] };
const inr = (n: number) => n.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** INR in and out of the treasury through the business's own Credible Finance account. */
export function BankPanel() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"add" | "out">("add");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/banking", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? `Something went wrong (${res.status}).`); setSetup(null); }
      else { setSetup(json as Setup); setError(""); }
    } catch { setError("Could not reach the server."); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  if (error) return <p role="alert" className="shake text-sm neg">{error}</p>;
  if (!setup) return <div className="skeleton h-40" />;
  if (!setup.configured) return <div className="card"><h2>Connect Credible Finance first</h2><p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Bank transfers run through this business&apos;s own Credible Finance account. An owner adds its API key and secret on the Settings page.</p></div>;

  return (
    <div>
      <div className="mb-3 flex gap-2" role="tablist" aria-label="Bank transfers">
        <button role="tab" aria-selected={tab === "add"} className={`btn btn-sm ${tab === "add" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("add")}>Add money (UPI)</button>
        <button role="tab" aria-selected={tab === "out"} className={`btn btn-sm ${tab === "out" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("out")}>Cash out to a bank</button>
      </div>
      {tab === "add" ? <AddMoney pairs={setup.on} /> : <CashOut pairs={setup.off} accounts={setup.accounts} reload={load} />}
    </div>
  );
}

function NameFields({ first, last, setFirst, setLast, what }: { first: string; last: string; setFirst: (v: string) => void; setLast: (v: string) => void; what: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block"><span className="label">First name {what}</span><input className="input mt-1" value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="off" /></label>
      <label className="block"><span className="label">Last name {what}</span><input className="input mt-1" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" /></label>
    </div>
  );
}

function AddMoney({ pairs }: { pairs: BankPair[] }) {
  const { run, error, loading } = useAction();
  const [pairId, setPairId] = useState(pairs[0]?.pairId ?? "");
  const [amount, setAmount] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [refund, setRefund] = useState("");
  const [quote, setQuote] = useState<{ usdc: number } | null>(null);
  const [qErr, setQErr] = useState("");
  const [done, setDone] = useState<{ id: string; upiIntent: string; upiQr: string; inr: number; expiresAt: string } | null>(null);
  const pair = pairs.find((p) => p.pairId === pairId);

  useEffect(() => {
    const n = Number(amount);
    if (!pair || !(n > 0)) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/banking?quote=on&pair=${encodeURIComponent(pair.pairId)}&amount=${n}`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) { setQuote(json); setQErr(""); } else { setQuote(null); setQErr(json.error ?? `Something went wrong (${res.status}).`); }
      } catch { if (live) { setQuote(null); setQErr("Could not reach the server."); } }
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [pair, amount]);

  if (!pairs.length) return <div className="card"><p className="text-sm" style={{ color: "var(--tx-1)" }}>Credible Finance has no rupee on-ramp that delivers USDC to a chain this app can bring into the treasury (Base, Arbitrum, Ethereum or Solana).</p></div>;
  if (done) {
    return (
      <div className="card grid gap-3">
        <h2>Pay {inr(done.inr)} in your UPI app</h2>
        <a className="btn btn-primary" href={done.upiIntent}>Open UPI app to pay</a>
        {done.upiQr && <p className="mono break-all text-xs" style={{ color: "var(--tx-2)" }}>Or scan: {done.upiQr.slice(0, 200)}</p>}
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>Once Credible Finance has your payment it buys the USDC and sends it on. NEAR Intents then moves it into the treasury, and it shows up in History as Funding. Pay before {new Date(done.expiresAt).toLocaleTimeString()}.</p>
        <button className="btn btn-ghost btn-sm" onClick={() => { setDone(null); setAmount(""); }}>Add more</button>
      </div>
    );
  }
  return (
    <form className="card grid gap-3" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run<{ receivable: { id: string; bank: { upiIntent: string; upiQr: string; inr: number; expiresAt: string } } }>("/api/banking", { action: "add", pairId, amountInr: Number(amount), firstName: first, lastName: last, refundTo: refund }, "POST", "Order made: pay it in your UPI app");
      if (r) setDone({ id: r.receivable.id, ...r.receivable.bank });
    }}>
      {pairs.length > 1 && (
        <label className="block"><span className="label">Delivered on</span>
          <select className="input mt-1" value={pairId} onChange={(e) => setPairId(e.target.value)}>{pairs.map((p) => <option key={p.pairId} value={p.pairId}>{p.input} to {p.output} on {p.chainName}</option>)}</select></label>
      )}
      <label className="block"><span className="label">Amount in rupees</span><input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} placeholder="5000" /></label>
      {quote && <p className="text-sm">About <strong className="amount">{quote.usdc.toFixed(2)} USDC</strong> into the treasury, after Credible&apos;s fees.</p>}
      {qErr && <p className="text-sm neg">{qErr}</p>}
      <NameFields first={first} last={last} setFirst={setFirst} setLast={setLast} what="on the paying bank account" />
      <label className="block"><span className="label">Refund address{pair ? ` on ${pair.chainName}` : ""}</span><input className="input mt-1 mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="Your own wallet: used only if the swap into the treasury fails" autoComplete="off" /></label>
      <button className="btn btn-primary" disabled={loading || !pair || !(Number(amount) > 0) || !first || !last || !refund}>{loading ? "Creating the order…" : "Create the UPI payment"}</button>
      <ErrorLine msg={error} />
    </form>
  );
}

function CashOut({ pairs, accounts, reload }: { pairs: BankPair[]; accounts: BankAccount[]; reload: () => Promise<void> }) {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const [pairId, setPairId] = useState(pairs[0]?.pairId ?? "");
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [quote, setQuote] = useState<{ inr: number } | null>(null);
  const [qErr, setQErr] = useState("");
  const [adding, setAdding] = useState(!accounts.length);
  const [num, setNum] = useState("");
  const [ifsc, setIfsc] = useState("");
  const pair = pairs.find((p) => p.pairId === pairId);

  useEffect(() => {
    const n = Number(amount);
    if (!pair || !(n > 0)) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/banking?quote=off&pair=${encodeURIComponent(pair.pairId)}&amount=${n}`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) { setQuote(json); setQErr(""); } else { setQuote(null); setQErr(json.error ?? `Something went wrong (${res.status}).`); }
      } catch { if (live) { setQuote(null); setQErr("Could not reach the server."); } }
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [pair, amount]);

  if (!pairs.length) return <div className="card"><p className="text-sm" style={{ color: "var(--tx-1)" }}>Credible Finance has no USDC to rupee off-ramp that takes a chain the treasury can pay on (Base, Arbitrum, Ethereum or Solana).</p></div>;
  return (
    <div className="grid gap-4">
      <div className="card grid gap-3">
        <h2>Bank account</h2>
        {accounts.length > 0 && (
          <label className="block"><span className="label">Pay to</span>
            <select className="input mt-1" value={account} onChange={(e) => setAccount(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.bank} ····{a.last4} ({a.holder})</option>)}</select></label>
        )}
        {adding ? (
          <div className="grid gap-3">
            <NameFields first={first} last={last} setFirst={setFirst} setLast={setLast} what="on the account" />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">Account number</span><input className="input mt-1 mono" inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} autoComplete="off" /></label>
              <label className="block"><span className="label">IFSC code</span><input className="input mt-1 mono" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} autoComplete="off" placeholder="HDFC0001234" /></label>
            </div>
            <p className="text-xs" style={{ color: "var(--tx-2)" }}>The number goes straight to Credible Finance, which keeps it. It is not stored here.</p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary" disabled={loading || !first || !last || !num || !ifsc} onClick={async () => {
                const r = await run<{ account: BankAccount }>("/api/banking", { action: "account", firstName: first, lastName: last, accountNumber: num, ifsc }, "POST", "Bank account saved");
                if (r) { setAccount(r.account.id); setNum(""); setIfsc(""); setAdding(false); await reload(); }
              }}>{loading ? "Saving…" : "Save the account"}</button>
              {accounts.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>}
            </div>
          </div>
        ) : <button type="button" className="btn btn-ghost btn-sm justify-self-start" onClick={() => setAdding(true)}>Add another account</button>}
      </div>
      <form className="card grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run<{ payment: { id: string } }>("/api/banking", { action: "cashout", pairId, amountUsdc: Number(amount), bankAccountId: account, firstName: first, lastName: last }, "POST", "Cash-out made: now it needs approval");
        if (r) router.push(`/payments/${r.payment.id}`);
      }}>
        <h2>Cash out</h2>
        {pairs.length > 1 && (
          <label className="block"><span className="label">Paid from</span>
            <select className="input mt-1" value={pairId} onChange={(e) => setPairId(e.target.value)}>{pairs.map((p) => <option key={p.pairId} value={p.pairId}>{p.input} on {p.chainName}</option>)}</select></label>
        )}
        <label className="block"><span className="label">Amount in USDC</span><input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} placeholder="100" /></label>
        {quote && <p className="text-sm">About <strong className="amount">{inr(quote.inr)}</strong> to the account, after Credible&apos;s fees.</p>}
        {qErr && <p className="text-sm neg">{qErr}</p>}
        {!adding && <NameFields first={first} last={last} setFirst={setFirst} setLast={setLast} what="on the account" />}
        <p className="text-xs" style={{ color: "var(--tx-2)" }}>The cash-out is a USDC payment like any other: your rules check it and your treasury approves it, and Credible only pays the rupees once the USDC arrives. The order lasts about 15 minutes, so be ready to approve.</p>
        <button className="btn btn-primary" disabled={loading || !pair || !account || !(Number(amount) >= 1) || !first || !last}>{loading ? "Creating the order…" : "Create the cash-out"}</button>
        <ErrorLine msg={error} />
      </form>
    </div>
  );
}
