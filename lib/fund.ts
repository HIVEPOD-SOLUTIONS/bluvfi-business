import { cfg } from "./business";
import { sha256 } from "./crypto";
import { state } from "./store";
import { scopedId } from "./tenant";
import type { Receivable } from "./types";

/**
 * A payment link to the business's own treasury: someone sends from any chain, NEAR Intents delivers USDC on NEAR to the treasury, and the
 * link says when it arrived. The same machine that collects client invoices, pointed at the business itself.
 */
export function createFundingLink(amountUsd: number): Receivable {
  const amount = Number(amountUsd);
  if (!(amount >= 1) || amount > 1_000_000) throw new Error("Give an amount from $1 to $1,000,000");
  if (!cfg().TREASURY_ACCOUNT) throw new Error("This business has no treasury yet. Set it up first.");
  const r: Receivable = {
    id: scopedId(`rcv-${sha256(`fund${Date.now()}${Math.random()}`).slice(0, 8)}`),
    client: "Treasury funding",
    description: "Money put into the treasury",
    amountUsd: Math.round(amount * 100) / 100,
    asset: "USDC",
    chain: "near",
    payTo: cfg().TREASURY_ACCOUNT,
    createdAt: new Date().toISOString(),
    kind: "funding",
    status: "open",
  };
  state().receivables.unshift(r);
  return r;
}
