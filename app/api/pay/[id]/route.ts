import { body, route, type Ctx } from "@/lib/http";
import { services } from "@/lib/services";
import { state } from "@/lib/store";
import { bizOfId } from "@/lib/tenant";

/**
 * Payment link for a receivable. The client picks the chain they hold USDC on and gives a refund address
 * on that chain; we ask NEAR Intents (1Click, mainnet) for a real quote and return the deposit address.
 * `check` asks 1Click whether the deposit arrived and marks the invoice paid on SUCCESS.
 * This endpoint is public (the client has no login), so it only ever creates quotes and reads status.
 */
export const POST = route<Ctx<"id">>(async (req, { params }) => {
  const { id } = await params;
  const r = state().receivables.find((x) => x.id === id);
  if (!r) throw new Error("Invoice not found");
  const b = await body<{ fromChain?: string; refundTo?: string; check?: boolean }>(req);

  if (b.check) {
    if (!r.deposit) throw new Error("No payment has been started for this invoice");
    const status = await services.swapStatus(r.deposit.address, r.deposit.memo);
    if (status === "SUCCESS") r.status = "paid";
    return { receivable: r, status };
  }
  if (r.status === "paid") throw new Error("This invoice is already paid");
  const fromChain = b.fromChain ?? "";
  if (!b.refundTo?.trim()) throw new Error("Enter an address on that chain where a refund can go if anything fails");
  const quote = await services.quoteReceivable(r.amountUsd, fromChain, b.refundTo.trim(), r.payTo);
  r.deposit = { chain: fromChain, address: quote.depositAddress, memo: quote.depositMemo, amountIn: quote.amountIn, deadline: quote.deadline };
  return { receivable: r, quote };
}, (_req, { params }) => params.then(({ id }) => bizOfId(id)));
