import { topUpIfLow } from "@/lib/custody";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** Hybrid custody: a signer asks the agent to check the spending wallet and, if it is low, propose a top-up to the DAO. */
export const POST = route(async (req) => {
  await requireSigner(req);
  return topUpIfLow();
});
