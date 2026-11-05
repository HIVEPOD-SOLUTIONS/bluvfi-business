import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEMO, MASTER_KEY } from "./config";
import { deriveKey } from "./crypto";
import { openText, sealText } from "./vault";
import { DEFAULT_POLICY_BODY, makePolicy } from "./policy";
import { services } from "./services";
import { currentBiz, DEFAULT_BIZ } from "./tenant";
import type { CounterpartySignals } from "./fraud";
import type { BlocklistEntry, Payment, Policy, PolicyProposal, PurchaseOrder, Receivable, TopUp, Vendor, ViewGrant } from "./types";

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
  /** A confidential treasury's login to 1Click (tokens encrypted), and the login proposal waiting for the council. */
  confidential?: {
    access?: string;
    refresh?: string;
    accessExp?: number;
    refreshExp?: number;
    login?: { message: string; nonce: string; hashHex: string; proposalId: number; startedAt: string };
    /** Moving the DAO's USDC into its shielded balance: deposit (a council vote), then shield (another, through the MPC signer). */
    shield?: {
      stage: "deposit" | "sign" | "submitted" | "done" | "failed";
      amountRaw: string;
      depositProposalId: number;
      signProposalId?: number;
      intent?: { standard: string; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string } };
      hashHex?: string;
      depositAddress?: string;
      intentHash?: string;
      detail: string;
    };
  };
  killSwitch: boolean;
  /** Who flipped the kill switch, and when. Any signer may. */
  killLog: { at: string; by: string; on: boolean }[];
  ledgerPublic: boolean;
  x402Spend: { at: string; url: string; priceUsd: number }[];
  checkLog: { at: string; verdict: string }[];
  /** The setup-time check of the private AI model: its attested signing keys (lib/aimodel.ts). */
  aiModel?: import("./nearai").ModelCheck;
  /** Hybrid custody: the latest DAO proposal to refill the spending wallet. */
  topUp?: TopUp;
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
/** SLH-DSA needs a 48-byte seed: two derivations, 32 + 16 bytes. */
export const slhSeed = () => deriveKey(need(), "slh-dsa-signing") + deriveKey(need(), "slh-dsa-signing:2").slice(0, 32);
export const pqSeeds = () => ({ mlDsa: pqSeed(), slhDsa: slhSeed() });

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
  killLog: [],
  ledgerPublic: false,
  x402Spend: [],
  checkLog: [],
});

// State lives in this process, one State per business, and is snapshotted to a JSON file after every write (set
// BLUVFI_PERSIST=0 to disable, e.g. in tests). The operator's own business ('default') keeps the original file; every
// other business has its own file under businesses/. The snapshot holds business data and encrypted records, not keys.
const BASE_FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_DATA_FILE ?? (DEMO ? ".data/demo.json" : ".data/state.json"));
const fileFor = (biz: string) => (!BASE_FILE ? "" : biz === DEFAULT_BIZ ? BASE_FILE : join(dirname(BASE_FILE), "businesses", `${biz}.json`));
const g = globalThis as unknown as { __bluvfiBusinesses?: Map<string, State> };
const all = () => (g.__bluvfiBusinesses ??= new Map());

function load(biz: string): State {
  const file = fileFor(biz);
  if (file && existsSync(file)) {
    try {
      const { text, legacy } = openText(readFileSync(file, "utf8"));
      const s = { ...fresh(), ...(JSON.parse(text) as Partial<State>) };
      if (legacy) writeSealed(file, s); // an old plain-text file is sealed on first read
      return s;
    } catch {
      throw new Error(`State file ${file} is unreadable (or BLUVFI_MASTER_KEY is not the key it was sealed with). Fix or move it; refusing to start empty over it.`);
    }
  }
  return fresh();
}

/** The records of the business this request runs in (lib/tenant.ts). */
export const state = (): State => {
  const biz = currentBiz();
  let s = all().get(biz);
  if (!s) all().set(biz, (s = load(biz)));
  return s;
};
/** Test helper: empty records for the current business. */
export const resetState = () => {
  const s = fresh();
  all().set(currentBiz(), s);
  return s;
};
/** Test helper: forget every business's records held in memory. */
export const resetAllState = () => all().clear();
/** False in tests and the CLI demo, which keep nothing on disk. */
export const persistenceOn = () => !!fileFor(currentBiz());

export function persist() {
  const file = fileFor(currentBiz());
  const s = all().get(currentBiz());
  if (!file || !s) return;
  writeSealed(file, s);
}

function writeSealed(file: string, s: State) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, sealText(JSON.stringify(s)));
  renameSync(tmp, file);
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
