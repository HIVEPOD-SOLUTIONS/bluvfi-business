import { pollAgentMarket } from "@/lib/agentmarket";
import { AGENT_MARKET_CRON_SECRET } from "@/lib/config";
import { route } from "@/lib/http";
import { cookieFrom, verifySession } from "@/lib/session";

/**
 * Runs one Agent Market polling pass. Allowed for a signed-in signer, or for a scheduler that sends
 * `Authorization: Bearer $AGENT_MARKET_CRON_SECRET` (point a cron job here every minute or so).
 */
export const POST = route(async (req) => {
  const bearer = req.headers.get("authorization");
  const cron = !!AGENT_MARKET_CRON_SECRET && bearer === `Bearer ${AGENT_MARKET_CRON_SECRET}`;
  if (!cron && !(await verifySession(cookieFrom(req)))) throw new Error("Sign in as a signer first");
  return { results: await pollAgentMarket() };
});
