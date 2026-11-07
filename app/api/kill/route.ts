import { setKillSwitch } from "@/lib/agent";
import { closeOpenCards } from "@/lib/cards";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { state } from "@/lib/store";

export const POST = route(async (req) => {
  const signer = await requireSigner(req);
  const { on } = await body<{ on?: boolean }>(req);
  setKillSwitch(!!on, signer);
  // Turning it on also closes every open one-time card, so nothing already handed out can still be charged.
  const cards = on ? await closeOpenCards({ all: true, why: `kill switch turned on by ${signer}` }) : undefined;
  return { killSwitch: state().killSwitch, cards };
});
