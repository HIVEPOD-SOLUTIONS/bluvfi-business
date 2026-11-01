import { checkSettlement } from "@/lib/agent";
import { relayVote } from "@/lib/custody";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/**
 * Gasless council votes. The browser signs a NEP-366 delegate action (one act_proposal on our DAO) with the
 * council member's own key; the relayer wraps it in a transaction and pays the gas. See lib/custody.ts relayVote
 * for what is checked before anything is relayed.
 */
export const POST = route(async (req) => {
  await requireSigner(req);
  const b = await body<{ signedDelegate?: string; paymentId?: string }>(req);
  if (!b.signedDelegate) throw new Error("signedDelegate (base64) is required");
  const relayed = await relayVote(b.signedDelegate);
  const payment = b.paymentId ? await checkSettlement(b.paymentId).catch(() => undefined) : undefined;
  return { ...relayed, payment };
});
