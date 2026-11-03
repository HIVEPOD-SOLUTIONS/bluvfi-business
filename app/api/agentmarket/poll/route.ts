import { bizFromRequest, cfg, secretEquals } from "@/lib/business";
import { pollAgentMarket } from "@/lib/agentmarket";
import { route } from "@/lib/http";
import { cookieFrom, verifySessionFull } from "@/lib/session";
import { runAs } from "@/lib/tenant";

const cronBiz = (req: Request) => {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!bearer) return null;
  try {
    const biz = bizFromRequest(req);
    return runAs(biz, () => secretEquals(bearer, cfg().AGENT_MARKET_CRON_SECRET)) ? biz : null;
  } catch {
    return null;
  }
};

/**
 * Runs one Agent Market polling pass for one business: a signed-in signer of that business, or a scheduler sending
 * `Authorization: Bearer <that business's cron secret>` to `/api/agentmarket/poll?b=<business id>` (Settings shows both).
 */
export const POST = route(
  async () => ({ results: await pollAgentMarket() }),
  async (req) => {
    const biz = cronBiz(req) ?? (await verifySessionFull(cookieFrom(req)))?.biz;
    if (!biz) throw new Error("Sign in as a signer first");
    return biz;
  },
);
