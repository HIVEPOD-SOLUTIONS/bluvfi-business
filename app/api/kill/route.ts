import { setKillSwitch } from "@/lib/agent";
import { body, route } from "@/lib/http";
import { state } from "@/lib/store";

export const POST = route(async (req) => {
  const { on } = await body<{ on?: boolean }>(req);
  setKillSwitch(!!on);
  return { killSwitch: state().killSwitch };
});
