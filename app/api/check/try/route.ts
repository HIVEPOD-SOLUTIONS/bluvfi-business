import { NextResponse } from "next/server";
import { publicCheck } from "@/lib/agent";
import { bizFromRequest } from "@/lib/business";
import { route } from "@/lib/http";
import { clientKey, limited } from "@/lib/ratelimit";
import type { CheckRequest } from "@/lib/types";

/** Free, tightly rate-limited tier used by the website's "Try a check" box. Agents should use the paid /api/check. */
export const POST = route(async (req) => {
  const wait = limited(`try:${clientKey(req)}`, Number(process.env.RATE_LIMIT_TRY_PER_MIN ?? 10));
  if (wait) return NextResponse.json({ error: "Free checks are rate limited" }, { status: 429, headers: { "retry-after": String(wait) } });
  const b = (await req.json().catch(() => ({}))) as CheckRequest;
  if (!b.payoutAddress) throw new Error("payoutAddress is required");
  return publicCheck(b);
}, bizFromRequest);
