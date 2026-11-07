import { createPrivateKey, sign as edSign } from "node:crypto";
import { processInvoice } from "./agent";
import { cfg } from "./business";
import { currentPolicy } from "./store";
import { needLive } from "./tenant";
import type { Confidentiality, Invoice, Payment } from "./types";

/**
 * US stocks and ETFs through Backpack Exchange, on the business's OWN Backpack account (Settings; the operator's own business reads
 * BACKPACK_API_KEY and BACKPACK_API_SECRET). Nothing is pooled: the shares sit in the business's own account at Backpack.
 *
 *  - Prices, the list and charts are Backpack's public data.
 *  - Funding: the treasury pays USDC on Base to the account's own deposit address, as an ordinary payment (the rules, the checks and the
 *    council's approval all apply). The address is Backpack's own answer to a signed call, trusted for that one thing.
 *  - Trading: a signed-in person buys or sells with the account's API key. One trade is capped by the council's "most for one investment" rule
 *    and by what the account holds, and is sent as a limit with a price cap, so it can only fill at or better than the price shown.
 *  - Not here: withdrawals. Backpack wants the destination in its address book and 2FA, so money and shares come out in Backpack itself.
 * The signed calls are built to Backpack's documented ED25519 scheme. Built to the same calls the Bluvfi app uses.
 */
const API = (process.env.BACKPACK_API_BASE ?? "https://api.backpack.exchange").replace(/\/$/, "");
const WINDOW_MS = 10_000;
const MIN_FUND_USD = 10;

export class StocksError extends Error {
  constructor(message: string, readonly httpStatus = 400, readonly code: string | null = null) { super(message); this.name = "StocksError"; }
}
export const stocksConfigured = () => { const c = cfg(); return !!(c.BACKPACK_API_KEY && c.BACKPACK_API_SECRET); };

type Params = Record<string, string | number | boolean | undefined>;
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const query = (p: Params) => Object.keys(p).filter((k) => p[k] !== undefined).sort().map((k) => `${k}=${p[k]}`).join("&");

/** Backpack signs the instruction name, the sorted fields, a timestamp and a window, with ED25519. Exported for the test. */
export function signature(instruction: string, params: Params, timestamp: number, secretB64: string): string {
  const seed = Buffer.from(secretB64, "base64");
  if (seed.length !== 32) throw new StocksError("The Backpack API secret must be a base64 32-byte ED25519 seed", 400, "NOT_CONFIGURED");
  const q = query(params);
  const payload = `instruction=${instruction}${q ? `&${q}` : ""}&timestamp=${timestamp}&window=${WINDOW_MS}`;
  return edSign(null, Buffer.from(payload), createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" })).toString("base64");
}

async function fail(res: Response): Promise<StocksError> {
  const text = await res.text().catch(() => "");
  let b: { code?: string; message?: string } | null = null;
  try { b = JSON.parse(text); } catch { /* plain text */ }
  return new StocksError(b?.message ?? (text.slice(0, 200) || `Backpack ${res.status}`), res.status, b?.code ?? null);
}
async function pub<T>(path: string, params: Params = {}): Promise<T> {
  const q = query(params);
  const res = await fetch(`${API}${path}${q ? `?${q}` : ""}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw await fail(res);
  return (await res.json()) as T;
}
async function signed<T>(method: "GET" | "POST", path: string, instruction: string, params: Params = {}): Promise<T> {
  const c = cfg();
  if (!c.BACKPACK_API_KEY || !c.BACKPACK_API_SECRET) throw new StocksError("This business has no Backpack account connected. Add its API key and secret on the Settings page.", 400, "NOT_CONFIGURED");
  const ts = Date.now();
  const headers = { "X-API-Key": c.BACKPACK_API_KEY, "X-Signature": signature(instruction, params, ts, c.BACKPACK_API_SECRET), "X-Timestamp": String(ts), "X-Window": String(WINDOW_MS), accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) };
  const q = query(params);
  const go = () => fetch(`${API}${path}${method === "GET" && q ? `?${q}` : ""}`, { method, headers, body: method === "POST" ? JSON.stringify(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))) : undefined, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  // A dropped connection is retried once, only for reads: an order must never be sent twice.
  const res = await (method === "GET" ? go().catch(() => go()) : go());
  if (!res.ok) throw await fail(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ---------- Public data ----------
export interface Stock { asset: string; ticker: string; name: string; priceUsd: number | null; change24hPct: number | null; minQty: number; step: number }
interface Security { asset: string; name: string; sessions?: { minQuantity: string; stepSize: string }[] }
interface Ticker { symbol: string; lastPrice: string; priceChangePercent: string }
const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
}
export const resetStocks = () => cache.clear();

/** Every stock and ETF Backpack lists, with its fair-market price (Backpack's "External" feed: the venue's own tape is thin). */
export async function listStocks(): Promise<Stock[]> {
  const [secs, ticks] = await Promise.all([
    cached("securities", 60 * 60_000, () => pub<Security[]>("/api/v1/securities")),
    cached("tickers", 15_000, () => pub<Ticker[]>("/api/v1/tickers", { source: "External" })),
  ]);
  const price = new Map(ticks.filter((t) => t.symbol.endsWith(".US_USDC")).map((t) => [t.symbol.replace(/_USDC$/, ""), t]));
  return secs.map((s): Stock => {
    const t = price.get(s.asset);
    const p = Number(t?.lastPrice), ch = Number(t?.priceChangePercent);
    const sess = s.sessions?.[0];
    return { asset: s.asset, ticker: s.asset.replace(/\.US$/, ""), name: s.name, priceUsd: t && Number.isFinite(p) && p > 0 ? p : null, change24hPct: t && Number.isFinite(ch) ? ch * 100 : null, minQty: Number(sess?.minQuantity) || 0, step: Number(sess?.stepSize) || 0 };
  });
}

export interface StockChart { asset: string; days: number; points: [number, number][]; changePct: number | null; high: number; low: number }
export async function stockChart(asset: string, days: number): Promise<StockChart> {
  if (!/^[A-Z0-9.]{1,12}\.US$/.test(asset)) throw new StocksError("That is not a US stock");
  if (![7, 30, 90, 365].includes(days)) throw new StocksError("Choose 7, 30, 90 or 365 days");
  const interval = days <= 7 ? "1h" : "1d";
  const rows = await cached(`k:${asset}:${days}`, 60_000, () => pub<{ start: string; close: string }[]>("/api/v1/klines", { symbol: `${asset}_USDC`, interval, startTime: Math.floor(Date.now() / 1000) - days * 86_400, source: "External" }));
  const points = rows.map((r): [number, number] => [Date.parse(r.start.includes("Z") || r.start.includes("+") ? r.start : `${r.start.replace(" ", "T")}Z`), Number(r.close)]).filter((p) => Number.isFinite(p[0]) && p[1] > 0);
  if (points.length < 2) throw new StocksError(`No price history for ${asset}`);
  const v = points.map((p) => p[1]);
  return { asset, days, points, changePct: ((points[points.length - 1][1] - points[0][1]) / points[0][1]) * 100, high: Math.max(...v), low: Math.min(...v) };
}

// ---------- The business's own account ----------
/** The account's deposit address on Base, from Backpack itself. */
export async function depositAddress(): Promise<string> {
  const a = (await signed<{ address?: string }>("GET", "/wapi/v1/capital/deposit/address", "depositAddressQuery", { blockchain: "Base" })).address ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new StocksError("Backpack gave no usable deposit address on Base", 502);
  return a;
}

export interface Position { asset: string; quantity: number }
export interface Account { usdc: number; positions: Position[] }
/** What the account holds: spendable USDC and the shares, from Backpack. */
export async function account(): Promise<Account> {
  const raw = await signed<Record<string, { available: string; locked: string; staked?: string }>>("GET", "/api/v1/capital", "balanceQuery");
  const total = (b: { available: string; locked: string }) => (Number(b.available) || 0) + (Number(b.locked) || 0);
  const usdc = Number(raw.USDC?.available) || 0;
  const positions = Object.entries(raw).filter(([k, b]) => k !== "USDC" && /\.US$/.test(k) && total(b) > 0).map(([asset, b]) => ({ asset, quantity: total(b) }));
  return { usdc, positions };
}

/** Put money into the account: a USDC payment on Base to Backpack's deposit address. Proposed here; the rules and the council decide it like any payment. */
export async function fundAccount(input: { amountUsd: number; confidentiality?: Confidentiality }): Promise<Payment> {
  needLive("fund a brokerage account");
  if (!(input.amountUsd >= MIN_FUND_USD) || input.amountUsd > 1_000_000) throw new StocksError(`Put in from $${MIN_FUND_USD} to $1,000,000`);
  if (!cfg().TREASURY_ACCOUNT) throw new StocksError("This business has no treasury yet. Set it up first.");
  const address = await depositAddress();
  const invoice: Invoice = {
    id: `stock-${Date.now()}`, vendorName: "Backpack Exchange", vendorDomain: "backpack.exchange", vendorContact: { channel: "email", handle: "support@backpack.exchange" },
    invoiceNumber: `BP-${Date.now().toString(36)}`, poNumber: "-", amountUsd: Math.round(input.amountUsd * 100) / 100, asset: "USDC", chain: "base", payoutAddress: address,
    text: `Fund this business's own Backpack Exchange account with ${input.amountUsd} USDC on Base, to buy US stocks and ETFs.`,
    receivedAt: new Date().toISOString(), category: "investment", issuedBy: "backpack",
  };
  return processInvoice(invoice, input.confidentiality ?? "basic");
}

// ---------- Trading ----------
export interface TradeInput { asset: string; side: "buy" | "sell"; amountUsd: number }
export interface TradeResult { asset: string; side: "buy" | "sell"; quantity: number; capPrice: number; status: string; spentUsd?: number; filledQty?: number; via: "rfq" | "spot" }

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;
/** The most the council lets one investment be. A trade over it, or with no cap set, is refused. */
function tradeCap(): number {
  const cap = currentPolicy().investMaxUsd ?? 0;
  if (!(cap > 0)) throw new StocksError("The council has not allowed investing: set the most for one investment on the Policy page first.");
  return cap;
}

/** Buy or sell with a price cap (1% from the shown price). Market hours use Backpack's request for quote, other hours its order book for the few stocks that have one. */
export async function trade(input: TradeInput): Promise<TradeResult> {
  needLive("trade stocks");
  const cap = tradeCap();
  if (!(input.amountUsd > 0)) throw new StocksError("Give an amount in dollars");
  if (input.amountUsd > cap) throw new StocksError(`The council allows up to $${cap.toLocaleString()} for one investment, and that is $${input.amountUsd}.`);
  const stock = (await listStocks()).find((s) => s.asset === input.asset);
  if (!stock) throw new StocksError(`${input.asset} is not a stock Backpack lists`);
  if (!stock.priceUsd) throw new StocksError(`${stock.ticker} has no price right now, so it cannot be traded`);
  const buy = input.side === "buy";
  const capPrice = Math.round(stock.priceUsd * (buy ? 1.01 : 0.99) * 100) / 100;
  const step = stock.step || 0.0001;
  const qty = Math.floor((input.amountUsd / capPrice) / step) * step;
  const quantity = Number(qty.toFixed(decimals(step)));
  if (!(quantity > 0) || quantity < stock.minQty) throw new StocksError(`That buys less than the smallest order of ${stock.ticker} (${stock.minQty} shares)`);
  const held = await account();
  if (buy && held.usdc < quantity * capPrice) throw new StocksError(`The account has $${held.usdc.toFixed(2)} to spend and this could cost $${(quantity * capPrice).toFixed(2)}. Fund it first.`);
  if (!buy && (held.positions.find((p) => p.asset === input.asset)?.quantity ?? 0) < quantity) throw new StocksError(`The account does not hold ${quantity} shares of ${stock.ticker}`);
  const clientId = Math.floor(Math.random() * 2 ** 31);
  const side = buy ? "Bid" : "Ask";
  const q = String(quantity), p = capPrice.toFixed(2);
  const session = await openNow();
  if (session) {
    const rfq = await signed<{ rfqId: string; status: string }>("POST", "/api/v1/rfq", "rfqSubmit", { symbol: `${input.asset}_USDC_RFQ`, side, quantity: q, price: p, executionMode: "Immediate", clientId });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const fills = await signed<{ fillQuantity?: string; fillQuoteQuantity?: string }[]>("GET", "/wapi/v1/history/rfq/fill", "rfqFillHistoryQueryAll", { rfqId: rfq.rfqId }).catch(() => []);
      if (fills.length) {
        const filledQty = fills.reduce((s, f) => s + (Number(f.fillQuantity) || 0), 0), spent = fills.reduce((s, f) => s + (Number(f.fillQuoteQuantity) || 0), 0);
        return { asset: input.asset, side: input.side, quantity, capPrice, status: "Filled", filledQty, spentUsd: spent, via: "rfq" };
      }
    }
    return { asset: input.asset, side: input.side, quantity, capPrice, status: "Sent: not filled yet. Check the account in a moment.", via: "rfq" };
  }
  if (!(await cached("spot", 30 * 60_000, () => pub<{ symbol: string; rwaMarketType?: string; marketType?: string }[]>("/api/v1/markets"))).some((m) => m.symbol === `${input.asset}_USDC` && m.rwaMarketType === "STOCK")) {
    throw new StocksError(`The US market is closed and ${stock.ticker} has no order book outside market hours. Try when the market is open.`);
  }
  const o = await signed<{ status: string; executedQuantity?: string; executedQuoteQuantity?: string }>("POST", "/api/v1/order", "orderExecute", { symbol: `${input.asset}_USDC`, side, orderType: "Limit", price: p, quantity: q, timeInForce: "IOC", clientId });
  return { asset: input.asset, side: input.side, quantity, capPrice, status: o.status, filledQty: Number(o.executedQuantity) || 0, spentUsd: Number(o.executedQuoteQuantity) || 0, via: "spot" };
}

/** Is a US-equities session open now? (Backpack's own session and holiday list.) */
async function openNow(now = new Date()): Promise<boolean> {
  type S = { startTime: string; endTime: string; startWeekday: number; endWeekday: number; timezone: string };
  type H = { market: string; date: string; startTime?: string; endTime?: string; timezone: string };
  const [sessions, holidays] = await Promise.all([cached("sessions", 60 * 60_000, () => pub<S[]>("/api/v1/market-sessions")), cached("holidays", 60 * 60_000, () => pub<H[]>("/api/v1/market-holidays")).catch(() => [] as H[])]);
  const parts = (tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
    return { day: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday], date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
  };
  const inDays = (d: number, a: number, b: number) => (a <= b ? d >= a && d <= b : d >= a || d <= b);
  if (holidays.some((h) => { if (h.market !== "US_EQUITIES") return false; const n = parts(h.timezone); return h.date === n.date && (!h.startTime || !h.endTime || (n.time >= h.startTime && n.time <= h.endTime)); })) return false;
  return sessions.some((s) => {
    const n = parts(s.timezone);
    if (s.startTime < s.endTime) return inDays(n.day, s.startWeekday, s.endWeekday) && n.time >= s.startTime && n.time < s.endTime;
    const prev = n.day === 1 ? 7 : n.day - 1;
    return (n.time >= s.startTime && inDays(n.day, s.startWeekday, s.endWeekday)) || (n.time < s.endTime && inDays(prev, s.startWeekday, s.endWeekday));
  });
}
