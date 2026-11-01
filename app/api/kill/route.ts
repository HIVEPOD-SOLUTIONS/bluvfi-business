import { setKillSwitch } from "@/lib/agent";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { state } from "@/lib/store";

export const POST = route(async (req) => {
  const signer = await requireSigner(req);
  const { on } = await body<{ on?: boolean }>(req);
  setKillSwitch(!!on, signer);
  return { killSwitch: state().killSwitch };
});
