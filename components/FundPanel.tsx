"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import { CardOnramp } from "@/components/CardOnramp";
import { toast } from "@/components/Toast";

/** Two ways to put money in: copy the treasury address (for a NEAR wallet), or get instructions to pay from any other chain or token. */
export function FundPanel({ account, ready, privyAppId = "" }: { account: string; ready: boolean; privyAppId?: string }) {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const [amount, setAmount] = useState("100");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="card">
        <p className="label">Option 1 · From a NEAR wallet</p>
        <h2 className="mt-1">Send USDC on NEAR</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Send USDC on the NEAR network to your treasury&apos;s address. It arrives in a minute or two.</p>
        {ready ? (
          <>
            <div className="mono mt-3 break-all rounded-lg p-3 text-sm" style={{ background: "var(--bg-2)" }}>{account}</div>
            <button className="btn btn-secondary btn-sm mt-3" onClick={async () => { try { await navigator.clipboard.writeText(account); toast("Address copied"); } catch { toast("Could not copy: select the address and copy it", "bad"); } }}>Copy the address</button>
            <p className="mt-3 text-sm neg">Only USDC on NEAR. Sending another coin or another network to this address can lose the money.</p>
          </>
        ) : <p className="mt-3 text-sm" style={{ color: "var(--amber)" }}>This business has no treasury yet. Set it up first, then come back here.</p>}
      </div>
      <div className="card">
        <p className="label">Option 2 · From any other chain or token</p>
        <h2 className="mt-1">Pay from Ethereum, Base, Solana, Bitcoin and more</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Say how much, and you get a deposit address on the chain you choose. NEAR Intents turns what you send into USDC in the treasury, at a live price shown before you pay.</p>
        <label className="mt-3 block"><span className="label">How much (USD)</span>
          <input className="input mt-1" type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button className="btn btn-primary mt-3" disabled={loading || !ready || !(Number(amount) >= 1)} aria-busy={loading} onClick={async () => {
          const r = await run<{ receivable: { id: string } }>("/api/fund", { amountUsd: Number(amount) }, "POST", "Funding link ready");
          if (r) router.push(`/pay/${r.receivable.id}`);
        }}>Get deposit instructions</button>
        <ErrorLine msg={error} />
      </div>
      <div className="card md:col-span-2">
        <p className="label">Option 3 · With a card, Apple Pay or Google Pay</p>
        <h2 className="mt-1">Buy USDC straight into the treasury</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>No crypto wallet needed. You buy USDC with a card, and it is sent to a deposit address made for this one purchase; NEAR Intents turns it into USDC in the treasury. The card provider shows its fee before you confirm.</p>
        <CardOnramp appId={privyAppId} ready={ready} />
      </div>
    </div>
  );
}
