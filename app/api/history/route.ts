import { NextResponse } from "next/server";
import { filterHistory, historyCsv, historyEntries } from "@/lib/history";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** The business's history as JSON, or as a CSV file (?format=csv) with the same filters the History page uses. */
export const GET = route(async (req) => {
  await requireSigner(req);
  const q = new URL(req.url).searchParams;
  const rows = filterHistory(historyEntries(), { category: q.get("category") ?? undefined, q: q.get("q") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, status: q.get("status") ?? undefined });
  if (q.get("format") === "csv") {
    return new NextResponse(historyCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="bluvfi-history.csv"' } });
  }
  return { entries: rows };
});
