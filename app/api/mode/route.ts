import { liveCfg } from "@/lib/business";
import { missingConfig } from "@/lib/config";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ, modeOf, setMode } from "@/lib/tenant";

/** What going live would still need: the business's own treasury settings, not anyone else's. */
const lacking = () => missingConfig(liveCfg(currentBiz()), currentBiz() !== DEFAULT_BIZ, false);

/**
 * Demo or live, for the signed-in business. Demo runs on fixtures (a simulated DAO, replayed AI reviews, no keys, no funds) and keeps its
 * own records; live uses the real services and the business's own records. Only an owner can switch, and going live needs the treasury set up.
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  return { mode: modeOf(currentBiz()), missingForLive: lacking() };
});

export const POST = route(async (req) => {
  const who = await requireSigner(req);
  if (!isOwner(who)) throw new Error("Only an owner can switch between demo and live");
  const { mode } = await body<{ mode?: string }>(req);
  if (mode !== "demo" && mode !== "live") throw new Error("Choose demo or live");
  if (mode === "live") {
    const missing = lacking();
    if (missing.length) throw new Error(`Live needs these set first: ${missing.map((m) => m.key).join(", ")}. ${currentBiz() === DEFAULT_BIZ ? "They are set in .env.local." : "Set up the treasury on the Setup page."}`);
  }
  setMode(currentBiz(), mode);
  return { mode };
});
