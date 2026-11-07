import { route } from "@/lib/http";
import { getMarket } from "@/lib/prices";
import { requireSigner } from "@/lib/session";

/** Live prices for the signed-in business: the top coins with their 24-hour change. The data providers' keys never reach the browser. */
export const GET = route(async (req) => {
  await requireSigner(req);
  const limit = Math.max(1, Math.min(250, Number(new URL(req.url).searchParams.get("limit")) || 100));
  return await getMarket(limit);
});
