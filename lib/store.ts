import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exclusive, fileStamp, writeAtomic } from "./shared-file";
import { DEMO, KYB_ENABLED, MASTER_KEY, PASSPORT_ENABLED } from "./config";
import { deriveKey } from "./crypto";
import { openText, sealText } from "./vault";
import { DEFAULT_POLICY_BODY, makePolicy } from "./policy";
import { services } from "./services";
import { currentBiz, DEFAULT_BIZ, isDemo } from "./tenant";
import type { CounterpartySignals } from "./fraud";
import type { BlocklistEntry, CardPurchase, Payment, Policy, PolicyProposal, PurchaseOrder, Receivable, TopUp, Vendor, ViewGrant } from "./types";

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
  /** Purchases the agent made with one-time cards (lib/cards.ts). Missing in files made before cards existed. */
  cardPurchases?: CardPurchase[];
  /** Agent chat: what the agent proposed and is waiting for its asker to confirm (lib/agent-chat.ts). Kept here, not in memory, so a
   * confirm reaching another instance of the app still finds it. Expires after 15 minutes. */
  chatPending?: Record<string, { by: string; tool: string; args: Record<string, unknown>; at: number }>;
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
  cardPurchases: [],
  checkLog: [],
});

// State lives in this process, one State per business, and is snapshotted to a JSON file after every write (set
// BLUVFI_PERSIST=0 to disable, e.g. in tests). The operator's own business ('default') keeps the original file; every
// other business has its own file under businesses/. The snapshot holds business data and encrypted records, not keys.
// A business in demo keeps its records in a space of its own (demo.json, businesses/<id>.demo.json), apart from its live records.
const PERSIST = process.env.BLUVFI_PERSIST !== "0";
// BLUVFI_DATA_FILE names the file of whichever kind this copy was started as (demo with BLUVFI_DEMO=1); the other kind sits beside it.
const DATA = process.env.BLUVFI_DATA_FILE;
const LIVE_FILE = DATA ? (DEMO ? `${DATA}.live` : DATA) : ".data/state.json";
const DEMO_FILE = DATA ? (DEMO ? DATA : `${DATA}.demo`) : ".data/demo.json";
const spaceKey = (biz: string, demo: boolean) => (demo ? `${biz}#demo` : biz);
const fileFor = (key: string) => {
  if (!PERSIST) return "";
  const demo = key.endsWith("#demo");
  const biz = demo ? key.slice(0, -5) : key;
  const base = demo ? DEMO_FILE : LIVE_FILE;
  return biz === DEFAULT_BIZ ? base : join(dirname(base), "businesses", `${biz}${demo ? ".demo" : ""}.json`);
};
const thisSpace = () => spaceKey(currentBiz(), isDemo());
const g = globalThis as unknown as { __bluvfiBusinesses?: Map<string, State>; __bluvfiStamps?: Map<string, string> };
const all = () => (g.__bluvfiBusinesses ??= new Map());
/** What each business's file looked like when this instance last read or wrote it, to notice another instance's writes. */
const stamps = () => (g.__bluvfiStamps ??= new Map());

function load(key: string): State {
  const file = fileFor(key);
  if (file && existsSync(file)) {
    try {
      const stamp = fileStamp(file);
      const { text, legacy } = openText(readFileSync(file, "utf8"));
      const s = { ...fresh(), ...(JSON.parse(text) as Partial<State>) };
      stamps().set(key, stamp);
      if (legacy) writeSealed(key, file, s); // an old plain-text file is sealed on first read
      return s;
    } catch {
      throw new Error(`State file ${file} is unreadable (or BLUVFI_MASTER_KEY is not the key it was sealed with). Fix or move it; refusing to start empty over it.`);
    }
  }
  return fresh();
}

/** The records of the business this request runs in (lib/tenant.ts). */
export const state = (): State => {
  const key = thisSpace();
  let s = all().get(key);
  if (!s) all().set(key, (s = load(key)));
  return s;
};

/**
 * Re-read this business's records if another instance has written them since this one last looked. Called at the start of
 * every request and page, so several instances sharing one .data folder all see the same records.
 */
export function refreshState() {
  const key = thisSpace();
  const file = fileFor(key);
  if (!file || !all().has(key)) return;
  const now = fileStamp(file);
  if (now && now !== stamps().get(key)) all().set(key, load(key));
}

/**
 * Change this business's records with nobody else changing them at the same time: other requests for the same business,
 * in this instance or any other, wait their turn. The records are re-read first and saved before the turn ends, so the next
 * request (wherever it runs) starts from them. This is also what stops two clicks on "approve" from paying twice.
 */
export function withRecords<T>(fn: () => Promise<T> | T, waitMs?: number): Promise<T> {
  const key = thisSpace();
  return exclusive(`records:${key}`, fileFor(key), async () => {
    refreshState();
    try {
      return await fn();
    } finally {
      persist();
    }
  }, waitMs);
}
/** Test helper: empty records for the current business. */
export const resetState = () => {
  const s = fresh();
  all().set(thisSpace(), s);
  return s;
};
/** Test helper: forget every business's records held in memory. */
export const resetAllState = () => all().clear();
/** False in tests and the CLI demo, which keep nothing on disk. */
export const persistenceOn = () => !!fileFor(thisSpace());

/**
 * One business's records in one mode, whichever mode the business is in now (for backups). Null if it has none.
 */
export function recordsOf(biz: string, demo: boolean): State | null {
  const key = spaceKey(biz, demo);
  const file = fileFor(key);
  if (all().has(key)) {
    if (file && fileStamp(file) && fileStamp(file) !== stamps().get(key)) all().set(key, load(key));
    return all().get(key)!;
  }
  if (file && existsSync(file)) {
    const s = load(key);
    all().set(key, s);
    return s;
  }
  return null;
}

/**
 * Put back one business's records in one mode (a restore), under the same lock every request for those records takes. The file
 * that was there is kept beside it (<file>.before-restore-<time>), never deleted.
 */
export async function replaceRecords(biz: string, demo: boolean, s: State, now = new Date()): Promise<string | undefined> {
  const key = spaceKey(biz, demo);
  const file = fileFor(key);
  return exclusive(`records:${key}`, file, async () => {
    let kept: string | undefined;
    if (file && existsSync(file)) {
      kept = `${file}.before-restore-${now.toISOString().replace(/[-:.]/g, "")}`;
      writeAtomic(kept, readFileSync(file));
    }
    const restored = { ...fresh(), ...s };
    all().set(key, restored);
    if (file) writeSealed(key, file, restored);
    return kept;
  });
}

export function persist() {
  const key = thisSpace();
  const file = fileFor(key);
  const s = all().get(key);
  if (!file || !s) return;
  writeSealed(key, file, s);
}

function writeSealed(key: string, file: string, s: State) {
  writeAtomic(file, sealText(JSON.stringify(s)));
  stamps().set(key, fileStamp(file));
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

const screened = new Map<string, import("./fraud").SanctionsResult>();
const screenKey = (address: string, name: string) => `${address.toLowerCase()}|${name.toLowerCase()}`;

/** Screen a payee against the sanctions list ahead of the (synchronous) fraud checks. A failure is recorded as "unavailable", never as clear. */
export async function prefetchSanctions(address: string, name: string) {
  try {
    screened.set(screenKey(address, name), await services.screenSanctions({ address, name: name || undefined }));
  } catch (e) {
    screened.set(screenKey(address, name), { status: "unavailable", hits: [], note: `Sanctions screening failed (${(e as Error).message}), so this payee was NOT screened.` });
  }
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
  sanctions: (address: string, name: string) => screened.get(screenKey(address, name)),
  kybEnabled: KYB_ENABLED,
  passportEnabled: PASSPORT_ENABLED,
  tiers: currentPolicy(),
});
