import { secretEquals } from "@/lib/business";
import { SETTLEMENT_CRON_SECRET } from "@/lib/config";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { pollAllBusinesses, pollSettlements } from "@/lib/settlement";

/**
 * Checks open payouts and payment links against 1Click and the custodians. A scheduler that sends
 * `Authorization: Bearer $SETTLEMENT_CRON_SECRET` checks every business; a signed-in signer checks their own business.
 */
export const POST = route(async (req) => {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (bearer && secretEquals(bearer, SETTLEMENT_CRON_SECRET)) return { businesses: await pollAllBusinesses() };
  await requireSigner(req);
  return { results: await pollSettlements() };
});
