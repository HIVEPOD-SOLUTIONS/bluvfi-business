import { body, route, type Ctx } from "@/lib/http";
import { findIntentsToken } from "@/lib/intents-tokens";
import { refreshReceivable } from "@/lib/receivables";
import { services } from "@/lib/services";
import { state } from "@/lib/store";
import { bizOfId } from "@/lib/tenant";

/**
 * Payment link for a receivable. The client picks a chain and a token NEAR Intents supports (or a chain, meaning USDC) and gives a refund address
 * on that chain; we ask NEAR Intents (1Click, mainnet) for a real quote and return the deposit address.
 * `check` asks 1Click whether the deposit arrived and marks the invoice paid on SUCCESS.
 * This endpoint is public (the client has no login), so it only ever creates quotes and reads status.
 */
export const POST = route<Ctx<"id">>(async (req, { params }) => {
  const { id } = await params;
  const r = state().receivables.find((x) => x.id === id);
  if (!r) throw new Error("Invoice not found");
  const b = await body<{ fromChain?: string; fromAsset?: string; refundTo?: string; check?: boolean }>(req);

  if (b.check) {
    if (!r.deposit) throw new Error("No payment has been started for this invoice");
    const s = await refreshReceivable(r);
    return { receivable: r, status: s.status, note: s.note };
  }
  if (r.status === "paid") throw new Error("This invoice is already paid");
  // A token must be one 1Click lists right now: this is a public endpoint, so nothing else reaches the quote.
  const token = b.fromAsset ? await findIntentsToken(String(b.fromAsset)) : undefined;
  if (b.fromAsset && !token) throw new Error("NEAR Intents does not take that token. Pick another.");
  const fromChain = token?.blockchain ?? b.fromChain ?? "";
  if (!b.refundTo?.trim()) throw new Error("Enter an address on that chain where a refund can go if anything fails");
  const quote = await services.quoteReceivable(r.amountUsd, token?.assetId ?? fromChain, b.refundTo.trim().slice(0, 200), r.payTo);
  r.deposit = { chain: fromChain, address: quote.depositAddress, memo: quote.depositMemo, amountIn: quote.amountIn, deadline: quote.deadline, symbol: token?.symbol ?? "USDC" };
  return { receivable: r, quote };
}, (_req, { params }) => params.then(({ id }) => bizOfId(id)));
