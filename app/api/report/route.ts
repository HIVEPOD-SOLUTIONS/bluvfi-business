import { reportFraud } from "@/lib/agent";
import { body, route } from "@/lib/http";

/** Agents that confirm fraud report it back, with evidence, to the shared blocklist. */
export const POST = route(async (req) => {
  const b = await body<{ kind?: "address" | "domain"; value?: string; reason?: string; evidence?: string; reportedBy?: string }>(req);
  if (!b.value || !b.reason || !b.evidence) throw new Error("value, reason and evidence are required");
  return { entry: reportFraud({ kind: b.kind === "domain" ? "domain" : "address", value: b.value, reason: b.reason, evidence: b.evidence, reportedBy: b.reportedBy ?? "agent:anonymous" }) };
});
