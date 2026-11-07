import { createFundingLink } from "@/lib/fund";
import { body, route } from "@/lib/http";
import { services } from "@/lib/services";
import { requireSigner } from "@/lib/session";

/** The least a card purchase can be: the on-ramp refuses smaller orders. */
const MIN_CARD_USD = 11;
const MAX_CARD_USD = 5_000;

/**
 * Put money into the treasury with a card. A card on-ramp (Privy's, which runs MoonPay or Coinbase under the hood) buys USDC on Base for the
 * person and sends it to an address we give it. That address is a NEAR Intents deposit address for this one funding: the USDC arrives
 * there, NEAR Intents turns it into USDC on NEAR and delivers it to the treasury. So this makes the funding link, asks NEAR Intents for the
 * deposit address on Base, and returns both; the browser then opens the card flow aimed at that address. A refund (if the swap ever fails)
 * goes back to the buyer's own address, never to us.
 */
export const POST = route(async (req) => {
  await requireSigner(req);
  const b = await body<{ amountUsd?: number; refundTo?: string }>(req);
  const amount = Number(b.amountUsd);
  if (!(amount >= MIN_CARD_USD) || amount > MAX_CARD_USD) throw new Error(`A card purchase is from $${MIN_CARD_USD} to $${MAX_CARD_USD.toLocaleString()}`);
  const refundTo = String(b.refundTo ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(refundTo)) throw new Error("A refund address on Base is needed (the buyer's own wallet)");
  const link = createFundingLink(amount);
  const quote = await services.quoteReceivable(link.amountUsd, "base", refundTo, link.payTo);
  const amountIn = Number(quote.amountIn);
  if (!/^0x[0-9a-fA-F]{40}$/.test(quote.depositAddress) || !(amountIn >= link.amountUsd)) throw new Error("NEAR Intents did not give a usable deposit address, so nothing was started");
  link.deposit = { chain: "base", address: quote.depositAddress, memo: quote.depositMemo, amountIn: quote.amountIn, deadline: quote.deadline };
  return { receivable: link, deposit: link.deposit, buyUsdc: amountIn };
});
