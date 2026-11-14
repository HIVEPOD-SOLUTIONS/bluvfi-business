import { runTurn, type Msg } from "@/lib/agent-chat";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { limited } from "@/lib/ratelimit";

/** Ask the agent in plain words. It reads what is asked, shows what it found, and may put one thing in front of you to confirm. */
export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const wait = limited(`chat:${by}`, 20);
  if (wait) throw new Error(`That is a lot of questions at once. Try again in ${wait} seconds.`);
  const b = await body<{ message?: string; history?: Msg[] }>(req);
  const history = (Array.isArray(b.history) ? b.history : []).filter((m): m is Msg => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string").slice(-8);
  return await runTurn(String(b.message ?? ""), history, by);
}, undefined, { lock: false }); // runTurn takes the records lock itself, after the model call
