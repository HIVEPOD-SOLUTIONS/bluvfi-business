import { cfg, getBusiness, setConfidential } from "@/lib/business";
import { advanceShield, finishConfidentialLogin, loginStatus, shieldStatus, startConfidentialLogin, startShield } from "@/lib/confidential-flow";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";

export const GET = route(async (req) => {
  await requireSigner(req);
  return { confidential: cfg().CONFIDENTIAL, login: loginStatus(), shield: shieldStatus() };
});

/**
 * A confidential treasury's login and switch. `login` has the agent file the login proposal (the council approves it); `check` reads
 * the council's vote and logs in; `enable` and `disable` turn a signed-up business's treasury into one (the operator's own is set
 * with CONFIDENTIAL_TREASURY in .env.local). Only an owner may start a login or change the switch.
 */
export const POST = route(async (req) => {
  const who = await requireSigner(req);
  const { action, usd } = await body<{ action?: string; usd?: number }>(req);
  if (action === "check") return { login: await finishConfidentialLogin() };
  if (action === "advance") return { shield: await advanceShield() };
  if (!isOwner(who)) throw new Error("Only an owner can do this");
  if (action === "shield") return { proposalId: (await startShield(Number(usd))).proposalId, shield: shieldStatus() };
  if (action === "login") return { proposalId: (await startConfidentialLogin()).proposalId, login: loginStatus() };
  if (action === "enable" || action === "disable") {
    if (currentBiz() === DEFAULT_BIZ) throw new Error("The operator's own treasury is switched with CONFIDENTIAL_TREASURY in .env.local");
    setConfidential(currentBiz(), action === "enable");
    return { confidential: !!getBusiness(currentBiz())?.treasury?.confidential };
  }
  throw new Error("Unknown action");
});
