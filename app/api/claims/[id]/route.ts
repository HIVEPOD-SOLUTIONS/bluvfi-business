import { NextResponse } from "next/server";
import { route, type Ctx } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { currentBiz } from "@/lib/tenant";
import { claimById } from "@/lib/zk-claims";

/** One claim's record, or with ?download=1 its proof as a file anyone can verify (`npm run zk:claim:verify -- <file>`). */
export const GET = route(async (req, ctx: Ctx<"id">) => {
  await requireSigner(req);
  const { id } = await ctx.params;
  const rec = claimById(id, currentBiz());
  if (!rec) throw new Error("No such claim");
  if (new URL(req.url).searchParams.get("download") === "1") {
    if (!rec.artifact) throw new Error("The proof is not ready yet");
    return new NextResponse(JSON.stringify(rec.artifact, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="bluvfi-${rec.kind}-proof-${rec.id}.json"` } });
  }
  return { claim: rec };
});
