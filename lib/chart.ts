/**
 * Price history for one coin, for the chart on the Prices page. CoinGecko's free API (no key): the ticker is turned into a CoinGecko id by its
 * search (the exact ticker with the best market-cap rank wins), then its market chart is read. Answers are kept for 5 minutes, a failed call is
 * never kept, and the points are thinned to at most 120 so the browser draws a light picture. Read-only: it is shown to people, it decides nothing.
 */
export interface Chart { symbol: string; days: number; points: [number, number][]; changePct: number | null; high: number; low: number; fetchedAt: number }

const GECKO_BASE = process.env.COINGECKO_API_BASE ?? "https://api.coingecko.com/api/v3";
const TTL_MS = 5 * 60_000;
export const CHART_DAYS = [1, 7, 30, 90, 365] as const;
const cache = new Map<string, { at: number; chart: Chart }>();
const ids = new Map<string, string>();

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${GECKO_BASE}${path}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(res.status === 429 ? "CoinGecko is rate limiting this server: try again in a minute" : `CoinGecko ${res.status}`);
  return (await res.json()) as T;
}

async function geckoId(symbol: string): Promise<string> {
  const known = ids.get(symbol);
  if (known) return known;
  const found = await get<{ coins?: { id: string; symbol: string; market_cap_rank: number | null }[] }>(`/search?query=${encodeURIComponent(symbol)}`);
  const hits = (found.coins ?? []).filter((c) => c.symbol.toUpperCase() === symbol);
  hits.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  if (!hits[0]) throw new Error(`No price history for ${symbol}`);
  ids.set(symbol, hits[0].id);
  return hits[0].id;
}

export function thin(points: [number, number][], max = 120): [number, number][] {
  if (points.length <= max) return points;
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

export async function getChart(symbol: string, days: number): Promise<Chart> {
  const s = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(s)) throw new Error("That is not a ticker");
  if (!(CHART_DAYS as readonly number[]).includes(days)) throw new Error(`Choose one of ${CHART_DAYS.join(", ")} days`);
  const key = `${s}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.chart;
  const id = await geckoId(s);
  const body = await get<{ prices?: unknown }>(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`);
  const raw = (Array.isArray(body.prices) ? body.prices : []).filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (raw.length < 2) throw new Error(`No price history for ${s}`);
  const points = thin(raw);
  const values = points.map((p) => p[1]);
  const chart: Chart = { symbol: s, days, points, changePct: points[0][1] ? ((points[points.length - 1][1] - points[0][1]) / points[0][1]) * 100 : null, high: Math.max(...values), low: Math.min(...values), fetchedAt: Date.now() };
  cache.set(key, { at: Date.now(), chart });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return chart;
}

export const resetCharts = () => { cache.clear(); ids.clear(); };
