"use client";
import { PrivyProvider, useCreateWallet, useFiatOnramp, useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useState } from "react";
import { ErrorLine } from "@/components/Actions";
import { toast } from "@/components/Toast";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MIN = 11;

/**
 * Buy USDC with a card, Apple Pay or Google Pay, straight into the treasury. The card flow is Privy's (it runs MoonPay or Coinbase for us, so
 * this app holds no provider credentials). It is aimed at a deposit address NEAR Intents made for this one funding; NEAR Intents turns
 * the USDC into USDC on NEAR in the treasury. The buyer signs in with Privy (their email) and needs a small wallet of their own, which is
 * where a refund would go if anything failed.
 */
export function CardOnramp({ appId, ready }: { appId: string; ready: boolean }) {
  if (!appId) return <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>Card purchases need Privy sign-in to be set up (PRIVY_APP_ID), with funding switched on in the Privy dashboard.</p>;
  return (
    <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google"], appearance: { theme: "dark", accentColor: "#0a0ae8" }, embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } } }}>
      <Flow ready={ready} />
    </PrivyProvider>
  );
}

function Flow({ ready }: { ready: boolean }) {
  const { authenticated, ready: privyReady } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { fund } = useFiatOnramp();
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ id: string; buy: number } | null>(null);

  async function buy() {
    setError(null);
    const usd = Number(amount);
    if (!(usd >= MIN)) { setError(`The smallest card purchase is $${MIN}.`); return; }
    setBusy(true);
    try {
      let address = wallets.find((w) => w.walletClientType === "privy")?.address ?? wallets[0]?.address;
      if (!address) address = (await createWallet()).address;
      // A funding link and a NEAR Intents deposit address on Base for this one purchase, with a refund to the buyer's own wallet.
      const res = await fetch("/api/fund/card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountUsd: usd, refundTo: address }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? `Something went wrong (${res.status}).`); return; }
      setStarted({ id: json.receivable.id, buy: json.buyUsdc });
      await fund({ source: {}, destination: { asset: BASE_USDC, chain: "eip155:8453", address: json.deposit.address }, defaultAmount: String(json.buyUsdc) });
      toast("Card purchase sent: it takes a few minutes to arrive");
    } catch (e) {
      const m = (e as Error).message ?? "";
      setError(/reject|cancel|closed/i.test(m) ? "The card purchase was cancelled. Nothing was bought." : "Could not open the card purchase. Try again, or fund from a wallet instead.");
    } finally {
      setBusy(false);
    }
  }

  if (!privyReady) return <div className="skeleton mt-3 h-10" />;
  if (!authenticated) return <button className="btn btn-secondary mt-3" onClick={() => login()}>Sign in with email to buy with a card</button>;
  return (
    <div className="mt-3">
      <label className="block"><span className="label">How much USDC to buy (min ${MIN})</span>
        <input className="input mt-1" type="number" min={MIN} max={5000} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button className="btn btn-primary mt-3" disabled={busy || !ready || !(Number(amount) >= MIN)} aria-busy={busy} onClick={buy}>Buy with a card</button>
      <ErrorLine msg={error} />
      {started && (
        <p className="reveal mt-3 text-sm" style={{ color: "var(--tx-1)" }}>
          Buying about {started.buy.toFixed(2)} USDC. It takes a few minutes to reach the treasury. <Link className="underline" href={`/pay/${started.id}`}>Follow it here</Link>. You pay the card fee on top, shown by the card provider before you confirm.
        </p>
      )}
    </div>
  );
}
