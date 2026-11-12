import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ID, chainName, INTENTS_ASSET_ID, isPayoutChain, PAYOUT_ASSETS, PAYOUT_CHAIN_KEYS, validPayoutAddress } from "./chains";
import { ONECLICK_BASE } from "./config";
import { isDemo } from "./tenant";

/**
 * Everything a client can pay in through NEAR Intents: every chain and token 1Click supports, read from its
 * public token list (GET /v0/tokens) and kept for an hour. Demo mode, and a failed read, use the copy saved in
 * fixtures/oneclick-tokens.json, so the list never disappears and demo stays offline. Tokens 1Click marks as
 * deprecated are left out.
 */
export interface IntentsToken { assetId: string; blockchain: string; symbol: string; decimals: number; price?: number }

export { chainName };

/** The chains most people pay from come first; the rest follow by name. */
const FIRST = ["eth", "base", "arb", "sol", "near", "btc", "bsc", "pol", "op", "avax", "tron", "ton"];
const STABLE = /^(USDC|USDT|USDT0|USDC\.e|DAI|USD1|USDG)$/i;

const SNAPSHOT = join(process.cwd(), "fixtures", "oneclick-tokens.json");
let saved: IntentsToken[] | undefined;
const snapshot = (): IntentsToken[] => (saved ??= (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { tokens: IntentsToken[] }).tokens);

let live: { at: number; tokens: IntentsToken[] } | undefined;
const HOUR = 60 * 60_000;

const usable = (t: Partial<IntentsToken>): t is IntentsToken =>
  typeof t.assetId === "string" && INTENTS_ASSET_ID.test(t.assetId) && typeof t.blockchain === "string" && /^[a-z0-9]{1,20}$/.test(t.blockchain)
  && typeof t.symbol === "string" && t.symbol.length > 0 && t.symbol.length <= 20 && !/deprecated/i.test(t.symbol) && Number.isInteger(t.decimals);

export async function intentsTokens(): Promise<IntentsToken[]> {
  if (isDemo()) return snapshot();
  if (live && Date.now() - live.at < HOUR) return live.tokens;
  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/tokens`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(String(res.status));
    const tokens = ((await res.json()) as Partial<IntentsToken>[]).filter(usable)
      .map(({ assetId, blockchain, symbol, decimals, price }) => ({ assetId, blockchain, symbol, decimals, price }));
    if (!tokens.length) throw new Error("empty");
    live = { at: Date.now(), tokens };
    return tokens;
  } catch {
    return live?.tokens ?? snapshot(); // a failed read is never kept; the last good list or the saved copy stands in
  }
}

export const findIntentsToken = async (assetId: string) => (await intentsTokens()).find((t) => t.assetId === assetId);
/** For demo fixtures only: the saved list, read without the network. */
export const savedIntentsToken = (assetId: string) => snapshot().find((t) => t.assetId === assetId);

export interface PayFromChain { chain: string; name: string; tokens: { assetId: string; symbol: string }[] }

/** The pay page's choices: each chain with its tokens, stablecoins first (USDC before USDT), then by symbol. */
export async function payFromChains(): Promise<PayFromChain[]> {
  const by = new Map<string, IntentsToken[]>();
  for (const t of await intentsTokens()) by.set(t.blockchain, [...(by.get(t.blockchain) ?? []), t]);
  const rank = (s: string) => (/^USDC$/i.test(s) ? 0 : /^USDT$/i.test(s) ? 1 : STABLE.test(s) ? 2 : 3);
  return [...by.entries()]
    .map(([chain, ts]) => ({
      chain, name: chainName(chain),
      tokens: [...new Map(ts.map((t) => [t.assetId, t])).values()]
        .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol))
        .map(({ assetId, symbol }) => ({ assetId, symbol })),
    }))
    .sort((a, b) => {
      const ia = FIRST.indexOf(a.chain), ib = FIRST.indexOf(b.chain);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
}

/**
 * The NEAR Intents asset a payout of `asset` on `chain` is delivered as, or undefined when there is no such route.
 * Only chains and stablecoins the app can check (lib/chains.ts PAYOUT_CHAINS, PAYOUT_ASSETS). A symbol listed twice
 * on one chain is ambiguous, so it is refused rather than guessed.
 */
export async function payoutAssetId(chain: string, asset: string): Promise<string | undefined> {
  const known = ASSET_ID[`${chain}:${asset}`];
  if (known) return known;
  if (!PAYOUT_CHAIN_KEYS.includes(chain) || !PAYOUT_ASSETS.includes(asset)) return undefined;
  const hits = (await intentsTokens()).filter((t) => t.blockchain === chain && t.symbol === asset);
  return hits.length === 1 ? hits[0].assetId : undefined;
}

export interface PayoutRoute { chain: string; name: string; assets: string[] }

/** Every chain the treasury can pay out on, with the stablecoins NEAR Intents delivers there, in the payout chains' order. */
export async function payoutRoutes(): Promise<PayoutRoute[]> {
  const out: PayoutRoute[] = [];
  for (const chain of PAYOUT_CHAIN_KEYS) {
    const assets: string[] = [];
    for (const a of PAYOUT_ASSETS) if (await payoutAssetId(chain, a)) assets.push(a);
    if (assets.length) out.push({ chain, name: chainName(chain), assets });
  }
  return out;
}

/**
 * What is wrong with paying `asset` on `chain` to `address`, in plain words, or null when nothing is. Checked before a
 * vendor, an invoice or a payroll line is accepted; 1Click's quote and the council's policy still check it again later.
 */
export async function payoutProblem(chain: string, asset: string, address: string): Promise<string | null> {
  if (!isPayoutChain(chain)) return `"${chain}" is not a chain we pay on`;
  if (!validPayoutAddress(chain, address)) return `"${address}" is not a ${chainName(chain)} address`;
  if (!PAYOUT_ASSETS.includes(asset) || !(await payoutAssetId(chain, asset))) return `${asset} on ${chainName(chain)} is not a route NEAR Intents offers`;
  return null;
}
