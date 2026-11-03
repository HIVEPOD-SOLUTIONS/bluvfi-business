import { body, route, type Ctx } from "@/lib/http";
import { services } from "@/lib/services";
import { state } from "@/lib/store";
import { bizOfId } from "@/lib/tenant";

/**
 * Aurora's Intents swap widget asks here for every quote on a pay link (its `fetchQuote` hook). The payer's
 * choices (token, wallet, refund address) come from the widget; the amount, USDC on NEAR and our treasury as
 * the recipient are forced by lib/rails.ts quoteForWidget. A real (non-dry) quote becomes the invoice's deposit,
 * so "check payment" settles it from 1Click exactly like the manual flow. Public: the client has no login.
 */
export const POST = route<Ctx<"id">>(async (req, { params }) => {
  const { id } = await params;
  const r = state().receivables.find((x) => x.id === id);
  if (!r) throw new Error("Invoice not found");
  if (r.status === "paid") throw new Error("This invoice is already paid");
  const request = await body<Record<string, unknown>>(req);
  const quote = await services.quoteForWidget(request, r.amountUsd, r.payTo);
  if (request.dry === false && quote.depositAddress) {
    r.deposit = {
      chain: `widget:${String(request.originAsset)}`,
      address: quote.depositAddress,
      memo: quote.depositMemo,
      amountIn: String(quote.amountInFormatted ?? quote.amountIn ?? ""),
      deadline: quote.deadline,
    };
  }
  return quote;
}, (_req, { params }) => params.then(({ id }) => bizOfId(id)));
