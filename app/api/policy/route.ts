import { approveProposal, propose, proposeToDao, syncDaoProposal } from "@/lib/governance";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import type { PolicyProposal } from "@/lib/types";

export const POST = route(async (req) => {
  const signer = await requireSigner(req);
  const b = await body<{ changes?: PolicyProposal["changes"]; approveId?: string; syncId?: string; sendId?: string }>(req);
  if (b.sendId) return { proposal: await proposeToDao(b.sendId) };
  if (b.syncId) return { proposal: await syncDaoProposal(b.syncId) };
  if (b.approveId) return { proposal: approveProposal(b.approveId, signer) };
  if (!b.changes) throw new Error("Missing changes");
  const c = b.changes;
  const nums = [c.perPaymentLimitUsd, c.dailyLimitUsd, c.approvalThresholdUsd, c.holdWindowMinutes, c.x402DailyLimitUsd];
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Limits must be zero or more");
  return { proposal: propose(c, signer) };
});
