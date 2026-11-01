"use client";
import "@aurora-is-near/intents-swap-widget/styles.css";
import { fireEvent, Widget, WidgetConfigProvider } from "@aurora-is-near/intents-swap-widget-standalone";
import { useEffect, useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/**
 * Pay this invoice from any wallet and almost any token, with Aurora's Intents swap widget (standalone build:
 * EVM and Solana via Reown AppKit, NEAR via near-connect, Stellar). The payer only picks a wallet and a token.
 * Every quote comes from our server (`fetchQuote`), which forces the invoice amount, USDC on NEAR and our
 * treasury, so the widget sends exactly the quoted amountIn to a 1Click deposit address we track.
 */
export default function AuroraPay({ id, apiKey, payTo, amountUsd }: { id: string; apiKey: string; payTo: string; amountUsd: number }) {
  const { run, error } = useAction();
  const [done, setDone] = useState<string | null>(null);

  // The invoice amount is what the treasury must receive, so it is set as the target (exact output), in USDC base units.
  useEffect(() => {
    const raw = BigInt(Math.round(amountUsd * 1e6)).toString();
    const t = setTimeout(() => fireEvent("tokenSetAmount", { variant: "target", amount: raw }), 300);
    return () => clearTimeout(t);
  }, [amountUsd]);

  return (
    <div className="mt-5">
      <WidgetConfigProvider
        theme={{ colorScheme: "dark", accentColor: "#0a0ae8", backgroundColor: "#1b1c19", borderRadius: "md", showContainer: false }}
        config={{
          apiKey,
          sendAddress: payTo,
          hideSendAddress: true,
          lockSwapDirection: true,
          defaultTargetToken: { symbol: "USDC", blockchain: "near" },
          allowedTargetTokensList: [USDC_NEAR],
          allowedTargetChainsList: ["near"],
          slippageTolerance: 100,
          fetchQuote: async (request, options) => {
            const res = await fetch(`/api/pay/${id}/quote`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              signal: options.signal,
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error ?? `Quote failed (${res.status})`);
            return j;
          },
        }}
      >
        <Widget
          defaultMode="swap"
          onMsg={(msg) => {
            if (msg.type === "on_transfer_success") {
              setDone(msg.transactionLink ?? msg.hash ?? "sent");
              void run(`/api/pay/${id}`, { check: true });
            }
          }}
        />
      </WidgetConfigProvider>
      {done && <p role="status" className="mt-3 text-sm pos">Payment sent. NEAR Intents is delivering it; this page updates when it settles.</p>}
      <ErrorLine msg={error} />
    </div>
  );
}
