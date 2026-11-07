import { checkSettlement } from "./agent";
import { refreshOpenBills } from "./bills";
import { businesses, getBusiness } from "./business";
import { refreshReceivable } from "./receivables";
import { persist, state } from "./store";
import { DEFAULT_BIZ, runAs } from "./tenant";

export interface SettlementPass {
  payments: { id: string; status: string }[];
  receivables: { id: string; status: string }[];
  errors: string[];
}

/**
 * One pass over a business's open money in flight: payouts waiting on votes or on funds, and payment links with a deposit
 * started. Each is asked about once; one failing never stops the rest. Run on a schedule (or by hand) so settlement does
 * not depend on someone pressing "check".
 */
export async function pollSettlements(): Promise<SettlementPass> {
  const out: SettlementPass = { payments: [], receivables: [], errors: [] };
  for (const p of [...state().payments].filter((x) => x.status === "ready_to_send" || x.status === "proposed")) {
    try {
      out.payments.push({ id: p.id, status: (await checkSettlement(p.id)).status });
    } catch (e) {
      out.errors.push(`${p.id}: ${(e as Error).message}`);
    }
  }
  for (const r of [...state().receivables].filter((x) => x.status === "open" && x.deposit)) {
    try {
      out.receivables.push({ id: r.id, status: (await refreshReceivable(r)).status });
    } catch (e) {
      out.errors.push(`${r.id}: ${(e as Error).message}`);
    }
  }
  try {
    await refreshOpenBills(); // bills already paid: has the code been delivered?
  } catch (e) {
    out.errors.push(`bills: ${(e as Error).message}`);
  }
  return out;
}

/** The same pass for every business on the platform, each inside its own business and saved on its own. */
export async function pollAllBusinesses(): Promise<Record<string, SettlementPass>> {
  getBusiness(DEFAULT_BIZ);
  const ids = [DEFAULT_BIZ, ...businesses().map((b) => b.id).filter((id) => id !== DEFAULT_BIZ)];
  const out: Record<string, SettlementPass> = {};
  for (const id of ids) {
    out[id] = await runAs(id, async () => {
      const pass = await pollSettlements();
      persist();
      return pass;
    });
  }
  return out;
}
