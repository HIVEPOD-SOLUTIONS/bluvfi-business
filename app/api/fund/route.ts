import { createFundingLink } from "@/lib/fund";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/**
 * Put money into the treasury from another chain or token. It makes a payment link to the business's own treasury (the same machine that
 * collects client invoices): the person sends from any chain, NEAR Intents delivers USDC on NEAR to the treasury, and the link says when it
 * arrived. Nothing is held anywhere in between.
 */
export const POST = route(async (req) => {
  await requireSigner(req);
  const b = await body<{ amountUsd?: number }>(req);
  return { receivable: createFundingLink(Number(b.amountUsd)) };
});
