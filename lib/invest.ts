import { processInvoice } from "./agent";
import { cfg } from "./business";
import { ASSET_ID } from "./chains";
import { ONECLICK_BASE, ONECLICK_JWT } from "./config";
import { viewFn } from "./custody";
import type { Confidentiality, Payment } from "./types";

/**
 * Investing, without handing the money to anyone: the treasury swaps some of its USDC into another coin through NEAR Intents, and the coin is
 * delivered into the treasury's own account there (its NEAR Intents balance, which only the treasury's council controls). It is an ordinary
 * payment: the council's investing rules in the policy (which coins, and the most for one investment) decide it, then the same checks and
 * the same treasury vote as any other payment. Nothing is held by Bluvfi or by a broker.
 *
 * What it does not do yet: selling back to USDC, or withdrawing a coin out to a chain. Those need the council to sign an intent, which is
 * its own piece of work; until then an investment is a one-way allocation that the council can move from the NEAR Intents account.
 */
const INTENTS = "intents.near";
/** The coins offered, by ticker, with the chain NEAR Intents lists them under. NEAR is held as wNEAR. */
const UNIVERSE: Record<string, { name: string; chain: string; assetId?: string }> = {
  BTC: { name: "Bitcoin", chain: "btc" }, ETH: { name: "Ether", chain: "eth" }, SOL: { name: "Solana", chain: "sol" },
  NEAR: { name: "NEAR (as wNEAR)", chain: "near", assetId: "nep141:wrap.near" }, XRP: { name: "XRP", chain: "xrp" }, DOGE: { name: "Dogecoin", chain: "doge" },
};

export interface InvestAsset { symbol: string; name: string; assetId: string; decimals: number; priceUsd: number }
interface OneClickToken { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number }

const headers = () => ({ "content-type": "application/json", ...(ONECLICK_JWT ? { authorization: `Bearer ${ONECLICK_JWT}` } : {}) });
let tokenCache: { at: number; tokens: OneClickToken[] } | undefined;

async function tokens(): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 5 * 60_000) return tokenCache.tokens;
  const res = await fetch(`${ONECLICK_BASE}/v0/tokens`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`NEAR Intents' coin list is unavailable (${res.status})`);
  tokenCache = { at: Date.now(), tokens: (await res.json()) as OneClickToken[] };
  return tokenCache.tokens;
}

/** The coins a business can invest in, with today's price from NEAR Intents' own list. */
export async function listAssets(): Promise<InvestAsset[]> {
  const all = await tokens();
  const out: InvestAsset[] = [];
  for (const [symbol, u] of Object.entries(UNIVERSE)) {
    const t = all.find((x) => (u.assetId ? x.assetId === u.assetId : x.symbol === symbol && x.blockchain === u.chain && /\.omft\.near$/.test(x.assetId)));
    if (t && t.price && t.price > 0) out.push({ symbol, name: u.name, assetId: t.assetId, decimals: t.decimals, priceUsd: t.price });
  }
  return out;
}

export interface AllocationPreview { symbol: string; amountUsd: number; youGet: number; worthUsd: number; costPct: number }

/** What a given amount would buy right now: a real quote from NEAR Intents, asked for and thrown away (nothing is sent or reserved). */
export async function previewAllocation(symbol: string, amountUsd: number): Promise<AllocationPreview> {
  const asset = (await listAssets()).find((a) => a.symbol === symbol);
  if (!asset) throw new Error(`${symbol} is not one of the coins offered`);
  if (!(amountUsd >= 10)) throw new Error("The smallest investment is $10");
  const res = await fetch(`${ONECLICK_BASE}/v0/quote`, {
    method: "POST", headers: headers(), signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ASSET_ID["near:USDC"], depositType: "ORIGIN_CHAIN", destinationAsset: asset.assetId,
      amount: BigInt(Math.round(amountUsd * 1e6)).toString(), refundTo: cfg().TREASURY_ACCOUNT || "near", refundType: "ORIGIN_CHAIN", recipient: cfg().TREASURY_ACCOUNT || "near", recipientType: "INTENTS",
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { message?: string; quote?: { amountOutFormatted?: string; amountOutUsd?: string; amountInUsd?: string } };
  if (!res.ok || !j.quote) {
    throw new Error(/liquidity/i.test(j.message ?? "") ? `NEAR Intents has no route for $${amountUsd} into ${symbol} right now. Try a different amount, or another coin.` : `NEAR Intents could not quote ${symbol} (${res.status}${j.message ? `: ${j.message}` : ""})`);
  }
  const youGet = Number(j.quote.amountOutFormatted);
  const worthUsd = Number(j.quote.amountOutUsd), inUsd = Number(j.quote.amountInUsd) || amountUsd;
  if (!Number.isFinite(youGet) || youGet <= 0) throw new Error("NEAR Intents gave no amount for that, so nothing can be ordered");
  return { symbol, amountUsd, youGet, worthUsd: Number.isFinite(worthUsd) ? worthUsd : amountUsd, costPct: Number.isFinite(worthUsd) ? Math.max(0, ((inUsd - worthUsd) / inUsd) * 100) : 0 };
}

/**
 * Propose an investment. It checks a real quote exists, then makes a payment of exactly this much USDC, marked as an investment so the council's
 * investing rules apply. It is decided and sent like any payment: this only proposes.
 */
export async function orderAllocation(input: { symbol: string; amountUsd: number; confidentiality?: Confidentiality }): Promise<{ payment: Payment; preview: AllocationPreview }> {
  const treasury = cfg().TREASURY_ACCOUNT;
  if (!treasury) throw new Error("This business has no treasury yet. Set it up first.");
  const amountUsd = Math.round(input.amountUsd * 100) / 100;
  const preview = await previewAllocation(input.symbol, amountUsd);
  const asset = (await listAssets()).find((a) => a.symbol === input.symbol)!;
  const payment = await processInvoice({
    id: `invest-${Date.now()}`, vendorName: "Treasury allocation", vendorDomain: "", vendorContact: { channel: "email", handle: "" },
    invoiceNumber: `INV-${asset.symbol}-${Date.now().toString(36)}`, poNumber: "-", amountUsd, asset: "USDC", chain: "near", payoutAddress: treasury,
    text: `Put $${amountUsd} of the treasury into ${asset.symbol}. The coin is kept in the treasury's own NEAR Intents account.`,
    receivedAt: new Date().toISOString(), category: "investment", issuedBy: "treasury", allocation: { assetId: asset.assetId, symbol: asset.symbol },
  }, input.confidentiality ?? "basic");
  return { payment, preview };
}

export interface Holding { symbol: string; name: string; tokenId: string; amount: number; priceUsd: number | null; valueUsd: number | null }

/** What the treasury holds in its NEAR Intents account, read from the chain, valued at NEAR Intents' prices. */
export async function holdings(account = cfg().TREASURY_ACCOUNT): Promise<Holding[]> {
  if (!account) return [];
  const owned = await viewFn<{ token_id: string }[]>(INTENTS, "mt_tokens_for_owner", { account_id: account, from_index: "0", limit: 100 });
  const ids = owned.map((t) => t.token_id);
  if (!ids.length) return [];
  const balances = await viewFn<string[]>(INTENTS, "mt_batch_balance_of", { account_id: account, token_ids: ids });
  const list = await tokens().catch(() => [] as OneClickToken[]);
  return ids.flatMap((id, i): Holding[] => {
    const raw = balances[i] ?? "0";
    if (raw === "0") return [];
    const t = list.find((x) => x.assetId === id);
    const amount = t ? Number(BigInt(raw)) / 10 ** t.decimals : Number(raw);
    const known = Object.entries(UNIVERSE).find(([, u]) => u.assetId === id || (t && t.symbol === Object.keys(UNIVERSE).find((k) => UNIVERSE[k] === u) && t.blockchain === u.chain));
    return [{ symbol: t ? (known?.[0] ?? t.symbol) : id, name: known?.[1].name ?? t?.symbol ?? id, tokenId: id, amount, priceUsd: t?.price ?? null, valueUsd: t?.price ? amount * t.price : null }];
  }).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

/** Test helper. */
export const resetInvest = () => { tokenCache = undefined; };
