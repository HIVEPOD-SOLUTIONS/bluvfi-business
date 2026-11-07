import { getChart } from "@/lib/chart";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** Price history for one coin (?symbol=BTC&days=7) for the chart on the Prices page. */
export const GET = route(async (req) => {
  await requireSigner(req);
  const q = new URL(req.url).searchParams;
  return await getChart(q.get("symbol") ?? "", Number(q.get("days")) || 7);
});
