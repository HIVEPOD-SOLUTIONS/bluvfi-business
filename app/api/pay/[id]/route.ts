import { body, route, type Ctx } from "@/lib/http";
import { findIntentsToken } from "@/lib/intents-tokens";
import { addDeposit, refreshReceivable } from "@/lib/receivables";
import { services } from "@/lib/services";
import { refreshState, state, withRecords } from "@/lib/store";
import { bizOfId } from "@/lib/tenant";

/**
 * Payment link for a receivable. The client picks a chain and a token NEAR Intents supports (or a chain, meaning USDC) and gives a refund address
 * on that chain; we ask NEAR Intents (1Click, mainnet) for a real quote and return the deposit address.
 * `check` asks 1Click whether a deposit arrived and marks the invoice paid on SUCCESS.
 * This endpoint is public (the client has no login), so it only ever creates quotes and reads status. The outside calls run
 * without the business's records lock (lock: false); only saving the result takes it.
 */
export const POST = route<Ctx<"id">>(async (req, { params }) => {
  const { id } = await params;
  const find = () => {
    const r = state().receivables.find((x) => x.id === id);
    if (!r) throw new Error("Invoice not found");
    return r;
  };
  const r = find();
  const b = await body<{ fromChain?: string; fromAsset?: string; refundTo?: string; check?: boolean }>(req);

  if (b.check) {
    if (!r.deposit && !r.earlier?.length) throw new Error("No payment has been started for this invoice");
    return withRecords(async () => {
      const fresh = find();
      const s = await refreshReceivable(fresh);
      return { receivable: { id: fresh.id, status: fresh.status, deposit: fresh.deposit ? { address: fresh.deposit.address } : undefined }, status: s.status, note: s.note };
    });
  }
  if (r.status === "paid") throw new Error("This invoice is already paid");
  // A token must be one 1Click lists right now: this is a public endpoint, so nothing else reaches the quote.
  const token = b.fromAsset ? await findIntentsToken(String(b.fromAsset)) : undefined;
  if (b.fromAsset && !token) throw new Error("NEAR Intents does not take that token. Pick another.");
  const fromChain = token?.blockchain ?? b.fromChain ?? "";
  if (!b.refundTo?.trim()) throw new Error("Enter an address on that chain where a refund can go if anything fails");
  const quote = await services.quoteReceivable(r.amountUsd, token?.assetId ?? fromChain, b.refundTo.trim().slice(0, 200), r.payTo);
  return withRecords(() => {
    refreshState();
    const fresh = find();
    if (fresh.status === "paid") throw new Error("This invoice is already paid");
    addDeposit(fresh, { chain: fromChain, address: quote.depositAddress, memo: quote.depositMemo, amountIn: quote.amountIn, deadline: quote.deadline, symbol: token?.symbol ?? "USDC" });
    // Only the person who asked sees these instructions; the link itself never shows another visitor's deposit.
    return { receivable: { id: fresh.id, status: fresh.status }, quote };
  });
}, (_req, { params }) => params.then(({ id }) => bizOfId(id)), { lock: false });
