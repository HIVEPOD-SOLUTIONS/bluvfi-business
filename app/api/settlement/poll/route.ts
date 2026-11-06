import { secretEquals } from "@/lib/business";
import { SETTLEMENT_CRON_SECRET } from "@/lib/config";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { redactDue } from "@/lib/kyb";
import { pollAllBusinesses, pollSettlements } from "@/lib/settlement";

/**
 * Checks open payouts and payment links against 1Click and the custodians. A scheduler that sends
 * `Authorization: Bearer $SETTLEMENT_CRON_SECRET` checks every business; a signed-in signer checks their own business.
 */
export const POST = route(async (req) => {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  // The same schedule also deletes verification documents at Persona once they have been kept long enough (lib/kyb.ts).
  if (bearer && secretEquals(bearer, SETTLEMENT_CRON_SECRET)) return { businesses: await pollAllBusinesses(), retention: await redactDue() };
  await requireSigner(req);
  return { results: await pollSettlements() };
});
