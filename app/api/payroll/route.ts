import { body, route } from "@/lib/http";
import { cancelPayrollRun, createPayrollRun, demoPayrollVote, payrollRuns, refreshPayrollRun, sendPayrollRun } from "@/lib/payroll";
import { requireSigner } from "@/lib/session";

/** Payroll runs (lib/payroll.ts). Any signer of the business can upload, send to the council, refresh or cancel a run not yet sent. */
export const GET = route(async (req) => {
  await requireSigner(req);
  return { runs: payrollRuns() };
});

/**
 * { action: "upload", csv, title } | { action: "send", id } | { action: "refresh", id } | { action: "cancel", id }
 * | { action: "vote", id, approve } (demo only: the simulated council; on mainnet the council votes in Trezu)
 */
export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ action?: string; csv?: string; title?: string; id?: string; approve?: boolean }>(req);
  const id = String(b.id ?? "");
  switch (b.action) {
    case "upload":
      if (typeof b.csv !== "string" || b.csv.length > 200_000) throw new Error("Paste or choose a CSV file (at most 200 KB)");
      return { run: await createPayrollRun(b.csv, String(b.title ?? ""), by) };
    case "send":
      return { run: await sendPayrollRun(id, by) };
    case "refresh":
      return { run: await refreshPayrollRun(id) };
    case "cancel":
      return { run: cancelPayrollRun(id, by) };
    case "vote":
      return { run: await demoPayrollVote(id, by, b.approve !== false) };
    default:
      throw new Error("Unknown action");
  }
});
