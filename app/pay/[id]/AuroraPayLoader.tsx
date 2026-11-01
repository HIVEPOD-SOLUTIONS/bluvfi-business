"use client";
import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";

// Wallet SDKs touch `window`, so the widget only ever renders in the browser.
const AuroraPay = dynamic(() => import("./AuroraPay"), { ssr: false, loading: () => <p className="mt-5 text-sm" style={{ color: "var(--tx-2)" }}>Loading wallets…</p> });

/** If the widget fails, say so and leave the manual deposit-address option below it working. */
class WidgetBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { failed: e.message };
  }
  render() {
    if (this.state.failed)
      return <p role="alert" className="mt-5 text-sm neg">The wallet widget could not load ({this.state.failed.slice(0, 120)}). Use the manual option below.</p>;
    return this.props.children;
  }
}

export function AuroraPayLoader(props: { id: string; apiKey: string; payTo: string; amountUsd: number }) {
  return (
    <WidgetBoundary>
      <AuroraPay {...props} />
    </WidgetBoundary>
  );
}
