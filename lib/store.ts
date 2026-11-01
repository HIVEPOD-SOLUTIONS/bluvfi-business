import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEMO, MASTER_KEY } from "./config";
import { deriveKey } from "./crypto";
import { DEFAULT_POLICY_BODY, makePolicy } from "./policy";
import { services } from "./services";
import type { CounterpartySignals } from "./fraud";
import type { BlocklistEntry, Payment, Policy, PolicyProposal, PurchaseOrder, Receivable, Vendor, ViewGrant } from "./types";

export interface State {
  policies: Policy[];
  proposals: PolicyProposal[];
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  blocklist: BlocklistEntry[];
  payments: Payment[];
  receivables: Receivable[];
  grants: ViewGrant[];
  sealed: Record<string, string>;
  killSwitch: boolean;
  ledgerPublic: boolean;
  x402Spend: { at: string; url: string; priceUsd: number }[];
  checkLog: { at: string; verdict: string }[];
  /** Demo mode only: the simulated treasury DAO (lib/custody.ts). */
  demoDao?: { lastId: number; proposals: Record<number, { id: number; status: string; kind: unknown; votes: Record<string, string>; description: string }> };
}

/** Keys come from BLUVFI_MASTER_KEY, never from the snapshot file. */
const need = () => {
  if (!/^[0-9a-f]{64}$/i.test(MASTER_KEY)) throw new Error("BLUVFI_MASTER_KEY is not set (64 hex characters)");
  return MASTER_KEY;
};
export const dataKey = () => deriveKey(need(), "record-encryption");
export const pqSeed = () => deriveKey(need(), "ml-dsa-signing");

const fresh = (): State => ({
  policies: [makePolicy(1, DEFAULT_POLICY_BODY)],
  proposals: [],
  vendors: [],
  purchaseOrders: [],
  blocklist: [],
  payments: [],
  receivables: [],
  grants: [],
  sealed: {},
  killSwitch: false,
  ledgerPublic: false,
  x402Spend: [],
  checkLog: [],
});

// State lives in this process and is snapshotted to a JSON file after every write (set BLUVFI_PERSIST=0 to
// disable, e.g. in tests). The snapshot holds business data and encrypted records, not keys.
const FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_DATA_FILE ?? (DEMO ? ".data/demo.json" : ".data/state.json"));
const g = globalThis as unknown as { __bluvfiBusiness?: State };

function load(): State {
  if (FILE && existsSync(FILE)) {
    try {
      return { ...fresh(), ...(JSON.parse(readFileSync(FILE, "utf8")) as Partial<State>) };
    } catch {
      throw new Error(`State file ${FILE} is unreadable. Fix or move it; refusing to start empty over it.`);
    }
  }
  return fresh();
}

export const state = (): State => (g.__bluvfiBusiness ??= load());
/** Test helper. */
export const resetState = () => {
  g.__bluvfiBusiness = fresh();
  return g.__bluvfiBusiness;
};
/** False in tests and the CLI demo, which keep nothing on disk. */
export const persistenceOn = () => !!FILE;

export function persist() {
  if (!FILE || !g.__bluvfiBusiness) return;
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(g.__bluvfiBusiness));
  renameSync(tmp, FILE);
}

export const currentPolicy = () => state().policies[state().policies.length - 1];

/** Paid or reserved today (a payment waiting for its deposit counts, so limits cannot be bypassed in parallel). */
export const spentTodayUsd = () => {
  const today = new Date().toISOString().slice(0, 10);
  return state().payments
    .filter((p) => (p.status === "paid" || p.status === "ready_to_send" || p.status === "proposed") && p.createdAt.startsWith(today))
    .reduce((s, p) => s + p.invoice.amountUsd, 0);
};

const live = new Map<string, CounterpartySignals>();

/** Fetch public on-chain facts ahead of the (synchronous) fraud checks. */
export async function prefetchCounterparty(address: string, chain?: string) {
  const s = await services.lookupSignals(address, chain);
  if (s) live.set(address.toLowerCase(), s);
}

export const counterparty = (address: string): CounterpartySignals => {
  const key = address.toLowerCase();
  const base = live.get(key) ?? { ageDays: null, isContract: null, codeChangedRecently: null, priorInteractions: 0, source: "unknown" as const };
  // Prior payments come from this treasury's own ledger.
  const prior = state().payments.filter((p) => p.status === "paid" && p.invoice.payoutAddress.toLowerCase() === key).length;
  return { ...base, priorInteractions: prior };
};

export const fraudContext = () => ({
  vendors: state().vendors,
  purchaseOrders: state().purchaseOrders,
  blocklist: state().blocklist,
  counterparty,
});
