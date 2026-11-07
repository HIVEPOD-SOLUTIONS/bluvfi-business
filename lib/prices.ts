/**
 * Live crypto prices for every business. CoinMarketCap when COINMARKETCAP_API_KEY is set (its key stays on the server; the browser only talks to
 * /api/prices), CoinGecko's free API otherwise or if CoinMarketCap fails. Both are refreshed about once a minute at the source, so answers are
 * kept for 60 seconds, and a failed call is never kept. Read-only: prices decide nothing here, they are shown to people.
 */
export interface PriceRow {
  rank: number;
  symbol: string;
  name: string;
  priceUsd: number;
  change24h: number | null;
  marketCapUsd: number | null;
}
export interface Market { rows: PriceRow[]; source: "coinmarketcap" | "coingecko"; fetchedAt: number }

const CMC_BASE = process.env.COINMARKETCAP_API_BASE ?? "https://pro-api.coinmarketcap.com";
const GECKO_BASE = process.env.COINGECKO_API_BASE ?? "https://api.coingecko.com/api/v3";
const TTL_MS = 60_000;
let cache: { at: number; limit: number; market: Market } | undefined;
let inflight: Promise<Market> | undefined;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function fromCoinMarketCap(limit: number): Promise<Market> {
  const key = process.env.COINMARKETCAP_API_KEY;
  if (!key) throw new Error("COINMARKETCAP_API_KEY is not set");
  const url = new URL("/v1/cryptocurrency/listings/latest", CMC_BASE);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("convert", "USD");
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": key, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => null)) as { status?: { error_code?: number | string; error_message?: string }; data?: { cmc_rank?: number; symbol: string; name: string; quote?: { USD?: { price?: number; percent_change_24h?: number; market_cap?: number } } }[] } | null;
  const code = Number(body?.status?.error_code ?? 0);
  if (!res.ok || code !== 0 || !Array.isArray(body?.data)) throw new Error(`CoinMarketCap ${res.status}${code ? ` (${code})` : ""}: ${body?.status?.error_message ?? "no data"}`);
  const rows = body.data.flatMap((c, i): PriceRow[] => {
    const q = c.quote?.USD;
    const price = num(q?.price);
    return price === null ? [] : [{ rank: c.cmc_rank ?? i + 1, symbol: c.symbol, name: c.name, priceUsd: price, change24h: num(q?.percent_change_24h), marketCapUsd: num(q?.market_cap) }];
  });
  return { rows, source: "coinmarketcap", fetchedAt: Date.now() };
}

async function fromCoinGecko(limit: number): Promise<Market> {
  const url = new URL(`${GECKO_BASE}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(Math.min(limit, 250)));
  url.searchParams.set("page", "1");
  url.searchParams.set("price_change_percentage", "24h");
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(res.status === 429 ? "CoinGecko is rate limiting this server: try again in a minute" : `CoinGecko ${res.status}`);
  const body = (await res.json()) as { market_cap_rank?: number; symbol: string; name: string; current_price?: number; price_change_percentage_24h?: number; market_cap?: number }[];
  const rows = body.flatMap((c, i): PriceRow[] => {
    const price = num(c.current_price);
    return price === null ? [] : [{ rank: c.market_cap_rank ?? i + 1, symbol: c.symbol.toUpperCase(), name: c.name, priceUsd: price, change24h: num(c.price_change_percentage_24h), marketCapUsd: num(c.market_cap) }];
  });
  return { rows, source: "coingecko", fetchedAt: Date.now() };
}

/** The top coins by market cap. CoinMarketCap first (if keyed), CoinGecko after it, so a price is almost always there. */
export async function getMarket(limit = 100): Promise<Market> {
  if (cache && cache.limit >= limit && Date.now() - cache.at < TTL_MS) return { ...cache.market, rows: cache.market.rows.slice(0, limit) };
  inflight ??= (async () => {
    let market: Market;
    try {
      market = await fromCoinMarketCap(Math.max(limit, 100));
    } catch (cmcError) {
      try {
        market = await fromCoinGecko(Math.max(limit, 100));
      } catch (geckoError) {
        throw new Error(`Prices are unavailable. ${(geckoError as Error).message}${process.env.COINMARKETCAP_API_KEY ? ` (CoinMarketCap: ${(cmcError as Error).message})` : ""}`);
      }
    }
    cache = { at: Date.now(), limit: Math.max(limit, 100), market };
    return market;
  })().finally(() => { inflight = undefined; });
  const m = await inflight;
  return { ...m, rows: m.rows.slice(0, limit) };
}

/** One coin's price by ticker (BTC, NEAR…), from the same cached market. */
export async function getPrice(symbol: string): Promise<PriceRow | undefined> {
  const s = symbol.trim().toUpperCase();
  return (await getMarket(250)).rows.find((r) => r.symbol === s);
}

/** Test helper. */
export const resetPrices = () => { cache = undefined; inflight = undefined; };
