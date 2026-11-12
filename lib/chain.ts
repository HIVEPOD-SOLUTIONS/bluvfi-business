import { cfg } from "./business";
import { EVM_RPC_URL, NEARBLOCKS_BASE, NEARBLOCKS_KEY, NEAR_ARCHIVAL_RPC_URL, NEAR_RPC_URL } from "./config";
import { NEAR_USDC_CONTRACT } from "./chains";
import type { CounterpartySignals } from "./fraud";

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const TTL_MS = 10 * 60_000;
/** A contract whose code differs from what it ran this many days ago is "changed recently". */
export const CODE_CHANGE_DAYS = 30;

const cache = new Map<string, { at: number; s: CounterpartySignals }>();

async function rpc(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  return r.json();
}

const nearQuery = (params: Record<string, unknown>) =>
  rpc(NEAR_RPC_URL, { jsonrpc: "2.0", id: "pp", method: "query", params: { finality: "final", ...params } }) as Promise<{
    result?: { code_hash?: string; amount?: string; result?: number[] };
    error?: { cause?: { name?: string } };
  }>;

async function nearSignals(account: string): Promise<CounterpartySignals> {
  const j = await nearQuery({ request_type: "view_account", account_id: account });
  // Account does not exist: nothing on-chain behind this address.
  if (j.error?.cause?.name === "UNKNOWN_ACCOUNT") return { ageDays: 0, isContract: false, codeChangedRecently: null, priorInteractions: 0, source: "near-rpc" };
  if (!j.result) throw new Error("no result");
  // view_account has no creation time; NearBlocks does (no key needed for light use). Unknown if it fails.
  const isContract = j.result.code_hash !== EMPTY_CODE_HASH;
  const [ageDays, codeChangedRecently] = await Promise.all([nearAccountAgeDays(account), isContract ? nearCodeChanged(account, j.result.code_hash!) : Promise.resolve(false)]);
  return { ageDays, isContract, codeChangedRecently, priorInteractions: 0, source: "near-rpc" };
}

/**
 * Did this contract's code change in the last CODE_CHANGE_DAYS? Compares its code hash now with its code hash at the block that old,
 * read from an archival node (the ordinary node forgets old blocks). null when the archive cannot answer: unknown is never reported as "no".
 */
async function nearCodeChanged(account: string, nowHash: string): Promise<boolean | null> {
  try {
    const call = (method: string, params: unknown) => rpc(NEAR_ARCHIVAL_RPC_URL, { jsonrpc: "2.0", id: "pp", method, params }) as Promise<{
      result?: { header?: { height?: number }; code_hash?: string };
      error?: { cause?: { name?: string } };
    }>;
    const head = (await call("block", { finality: "final" })).result?.header?.height;
    if (!head) return null;
    // NEAR makes about one block a second.
    const old = await call("query", { request_type: "view_account", block_id: head - CODE_CHANGE_DAYS * 86_400, account_id: account });
    if (old.error?.cause?.name === "UNKNOWN_ACCOUNT") return true; // it did not exist then and has code now
    if (!old.result?.code_hash) return null;
    return old.result.code_hash !== nowHash;
  } catch {
    return null;
  }
}

/** Days since the account was created, from NearBlocks (data.created.block_timestamp is in nanoseconds). */
async function nearAccountAgeDays(account: string): Promise<number | null> {
  try {
    const r = await fetch(`${NEARBLOCKS_BASE}/v3/accounts/${encodeURIComponent(account)}`, {
      headers: NEARBLOCKS_KEY ? { authorization: `Bearer ${NEARBLOCKS_KEY}` } : {},
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const ts = ((await r.json()) as { data?: { created?: { block_timestamp?: string } } }).data?.created?.block_timestamp;
    return ts ? Math.max(0, Math.floor((Date.now() - Number(BigInt(ts) / BigInt(1_000_000))) / 86_400_000)) : null;
  } catch {
    return null;
  }
}

async function evmSignals(address: string): Promise<CounterpartySignals> {
  const call = (method: string) => rpc(EVM_RPC_URL, { jsonrpc: "2.0", id: 1, method, params: [address, "latest"] }) as Promise<{ result?: string }>;
  const [code, nonce] = await Promise.all([call("eth_getCode"), call("eth_getTransactionCount")]);
  if (code.result === undefined || nonce.result === undefined) throw new Error("no result");
  const isContract = code.result !== "0x";
  // An address that has never sent a transaction and holds no code is treated as brand new.
  const unused = !isContract && parseInt(nonce.result, 16) === 0;
  return { ageDays: unused ? 0 : null, isContract, codeChangedRecently: null, priorInteractions: 0, source: "near-rpc" };
}

/** Public on-chain facts about a payee. Returns undefined when the chain is unsupported or the RPC fails. */
export async function lookupSignals(address: string, chain?: string): Promise<CounterpartySignals | undefined> {
  const lower = address.toLowerCase();
  const key = `${chain ?? ""}:${lower}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.s;
  try {
    const isEvm = /^0x[0-9a-f]{40}$/i.test(address) && (!chain || chain === "eth");
    const isNear = chain === "near" || (!chain && (/\.near$/.test(lower) || /^[0-9a-f]{64}$/.test(lower)));
    const s = isEvm ? await evmSignals(address) : isNear ? await nearSignals(lower) : undefined;
    if (s) cache.set(key, { at: Date.now(), s });
    return s;
  } catch {
    return undefined;
  }
}

export interface Balance { chain: string; asset: string; amount: number; usd: boolean }

/** Live treasury balances on NEAR mainnet: USDC (counted as USD) and NEAR (units, not converted). */
export async function treasuryBalances(): Promise<Balance[]> {
  if (!cfg().TREASURY_ACCOUNT) throw new Error("TREASURY_ACCOUNT is not set");
  return accountBalances(cfg().TREASURY_ACCOUNT);
}

/** Hybrid custody: the OutLayer spending wallet's balances, read the same way. */
export async function spendingWalletBalances(): Promise<Balance[]> {
  if (!cfg().OUTLAYER_WALLET_ACCOUNT) throw new Error("OUTLAYER_WALLET_ACCOUNT is not set");
  return accountBalances(cfg().OUTLAYER_WALLET_ACCOUNT);
}

export async function accountBalances(account: string): Promise<Balance[]> {
  const [acct, usdc] = await Promise.all([
    nearQuery({ request_type: "view_account", account_id: account }),
    nearQuery({
      request_type: "call_function",
      account_id: NEAR_USDC_CONTRACT,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString("base64"),
    }),
  ]);
  const out: Balance[] = [];
  const raw = usdc.result?.result ? JSON.parse(Buffer.from(usdc.result.result).toString()) : "0";
  out.push({ chain: "near", asset: "USDC", amount: Number(BigInt(raw)) / 1e6, usd: true });
  if (acct.result?.amount) out.push({ chain: "near", asset: "NEAR", amount: Number(BigInt(acct.result.amount) / BigInt("1000000000000000000")) / 1e6, usd: false });
  return out;
}
