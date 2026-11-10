import { runAttacks } from "@/lib/demo-scenario";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { isDemo } from "@/lib/tenant";

/**
 * The Attack lab (app/attack): run the three attacks on the treasury through the real pipeline. Demo mode only, so a live business
 * never fills its records with attacks; in demo the AI reviews are signed replays, two of which play a model that was fooled.
 */
export const POST = route(async (req) => {
  await requireSigner(req);
  if (!isDemo()) throw new Error("The Attack lab runs in demo mode. Switch this business to demo on the Settings page to try it.");
  const out = await runAttacks();
  return { attacks: out.map((p) => ({ id: p.id, status: p.status, ai: p.ai.decision })) };
});
