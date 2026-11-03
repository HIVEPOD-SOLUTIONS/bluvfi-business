import { timingSafeEqual } from "node:crypto";
import { SIGNERS } from "@/lib/config";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { isOwner } from "@/lib/team";
import { finishSetup, planSetup, setupCode } from "@/lib/setup";

/** With signers configured, only a signed-in signer may set up a treasury; before that, whoever holds the setup code. */
async function access(req: Request) {
  if (currentBiz() !== DEFAULT_BIZ) {
    // A business that signed up: only its own signed-in owners may set up its treasury.
    const who = await requireSigner(req);
    if (!isOwner(who)) throw new Error("Only an owner can set up the treasury");
    return who;
  }
  if (SIGNERS.length) return requireSigner(req);
  const given = Buffer.from(req.headers.get("x-setup-code") ?? "");
  const code = Buffer.from(setupCode());
  if (given.length !== code.length || !timingSafeEqual(given, code)) {
    throw new Error("Wrong setup code. It is printed in the terminal running the app.");
  }
  return "setup";
}

export const POST = route(async (req) => {
  await access(req);
  const b = await body<{ action?: string; funder?: string; council?: string[]; name?: string; agent?: string }>(req);
  if (b.action === "check") return { ok: true };
  if (b.action === "plan") return { plan: await planSetup({ funder: b.funder ?? "", council: b.council ?? [], name: b.name ?? "", agent: b.agent }) };
  if (b.action === "finish") return { result: await finishSetup() };
  throw new Error("Unknown action");
});
