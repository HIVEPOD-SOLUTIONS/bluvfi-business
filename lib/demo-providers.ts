import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { state } from "./store";
import { currentBiz } from "./tenant";

/**
 * Demo fixtures for the providers a business reaches over the network: Bitrefill, Cryptorefills, Credible Finance and Backpack Exchange.
 * They answer in each provider's own shape, so everything above them (the checks on an order's address, amount and deadline, the payment
 * it becomes, the policy gate and the simulated DAO) runs exactly as it does live. Only used by a business in demo; nothing leaves the
 * machine, and the deposit addresses are made-up ones that no one holds a key for.
 */
const FAKE_EVM = `0x${"de30".repeat(10)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const hash = (s: string) => createHash("sha256").update(s).digest();
/** A steady number in [0,1) from a text, so a fixture answers the same way each time. */
const unit = (s: string, i = 0) => hash(`${s}:${i}`).readUInt32BE(0) / 2 ** 32;
const demoId = (p: string) => `demo-${p}-${randomUUID().slice(0, 8)}`;
/** Does this business's payment for a provider order show as paid? (The simulated DAO has voted and the payout has gone through.) */
const paidFor = (orderId: string) => state().payments.some((p) => p.bill?.invoiceId === orderId && p.status === "paid");

// ---------- Bitrefill ----------
interface DemoBill { id: string; name: string; type: string; countries: string[]; categories: string[]; currency: string; recipient: string; packages: [string, number][] }
const BILLS: DemoBill[] = [
  { id: "netflix-usa", name: "Netflix USA", type: "giftcards", countries: ["US"], categories: ["entertainment", "streaming"], currency: "USD", recipient: "none", packages: [["15", 15], ["30", 30], ["60", 60]] },
  { id: "amazon-usa", name: "Amazon.com USA", type: "giftcards", countries: ["US"], categories: ["shopping"], currency: "USD", recipient: "none", packages: [["10", 10], ["25", 25], ["50", 50], ["100", 100]] },
  { id: "steam-usa", name: "Steam USA", type: "giftcards", countries: ["US"], categories: ["gaming"], currency: "USD", recipient: "none", packages: [["20", 20], ["50", 50]] },
  { id: "uber-usa", name: "Uber USA", type: "giftcards", countries: ["US"], categories: ["travel"], currency: "USD", recipient: "none", packages: [["25", 25], ["50", 50]] },
  { id: "mtn-nigeria", name: "MTN Nigeria top-up", type: "refill", countries: ["NG"], categories: ["refill"], currency: "NGN", recipient: "phone_number", packages: [["1000", 0.66], ["5000", 3.3]] },
  { id: "airalo-europe", name: "Airalo eSIM Europe 5 GB", type: "esim", countries: ["EU"], categories: ["esim"], currency: "USD", recipient: "none", packages: [["5GB-30d", 13.5]] },
];

export function demoBitrefill(tool: string, args: Record<string, unknown>): string {
  if (tool === "search-products") {
    const q = String(args.query ?? "").toLowerCase();
    const hits = BILLS.filter((b) => `${b.name} ${b.id} ${b.categories.join(" ")}`.toLowerCase().includes(q) && (!args.country || b.countries.includes(String(args.country))));
    return [
      "categories[0]{count,highlighted,value}:",
      `products[${hits.length}]:`,
      ...hits.flatMap((b) => [`  - _id: ${b.id}`, `    categories[${b.categories.length}]: ${b.categories.join(",")}`, `    countries[${b.countries.length}]: ${b.countries.join(",")}`, `    currency: ${b.currency}`, "    in_stock: true", `    name: ${b.name}`, `    type: ${b.type}`]),
      `found: ${hits.length}`, "page: 1",
    ].join("\n");
  }
  if (tool === "get-product-details") {
    const b = BILLS.find((x) => x.id === args.product_id);
    if (!b) return "";
    return [
      `id: ${b.id}`, `name: ${b.name}`, `country_code: ${b.countries[0]}`, "currency: USD", `categories[${b.categories.length}]: ${b.categories.join(",")}`, `recipient_type: ${b.recipient}`, "in_stock: true",
      `packages[${b.packages.length}]{package_value,package_currency,payment_price,payment_currency}:`,
      ...b.packages.map(([v, p]) => `  "${v}",${b.currency},"${p.toFixed(2)}",USD`),
    ].join("\n");
  }
  if (tool === "buy-products") {
    const item = (args.cart_items as { product_id?: string; package_value?: string }[] | undefined)?.[0];
    const b = BILLS.find((x) => x.id === item?.product_id);
    const price = b?.packages.find(([v]) => v === String(item?.package_value))?.[1];
    if (!b || !price) throw new Error("Bitrefill: product unavailable (demo)");
    return JSON.stringify({ invoice_id: randomUUID(), invoice_access_token: "demo-token", created_time: new Date().toISOString(), payment_info: { address: FAKE_EVM, altcoinPrice: (Math.round(price * 1.002 * 100) / 100).toFixed(2), currency: "USDC" } });
  }
  if (tool === "get-invoice-by-id") {
    const id = String(args.invoice_id ?? "");
    return `invoice_id: ${id}\ninvoice_status: ${paidFor(id) ? "complete" : "unpaid"}`;
  }
  throw new Error("Bitrefill: unknown tool (demo)");
}

// ---------- Cryptorefills ----------
interface DemoCr { id: string; brand: string; category: string; label: string; price: number | null; min?: number; max?: number }
const CR: DemoCr[] = [
  { id: "cr-amz-25", brand: "Amazon", category: "Shopping", label: "$25", price: 25.1 }, { id: "cr-amz-50", brand: "Amazon", category: "Shopping", label: "$50", price: 50.2 },
  { id: "cr-amz-range", brand: "Amazon", category: "Shopping", label: "Any amount", price: null, min: 10, max: 200 },
  { id: "cr-nflx-30", brand: "Netflix", category: "Streaming", label: "$30", price: 30.1 }, { id: "cr-spot-10", brand: "Spotify", category: "Streaming", label: "$10", price: 10.05 },
  { id: "cr-play-25", brand: "Google Play", category: "Gaming", label: "$25", price: 25.1 },
];

export function demoCryptorefillsGet(path: string, params: Record<string, string | number | undefined>): unknown {
  if (path === "/v1/brands") {
    const seen = new Map<string, DemoCr>();
    for (const c of CR) if (!seen.has(c.brand)) seen.set(c.brand, c);
    return [...seen.values()].map((c) => ({ brand_name: c.brand, family: c.brand, category: c.category }));
  }
  if (path === "/v1/catalog") {
    return CR.filter((c) => c.brand === params.brand_name).map((c) => ({
      product_id: c.id, product_name: `${c.brand} ${c.label}`, brand_name: c.brand, denomination: c.price ? String(c.price) : "range", denomination_label: c.label, currency: "USD",
      is_range: c.price === null, price_usdc: c.price === null ? "variable" : c.price.toFixed(2), min_value: c.min, max_value: c.max,
    }));
  }
  if (path === "/v3/payment_vias") return [{ name: "USER_WALLET", available: true, currencies: [{ name: "USDC", networks: [{ name: "Base" }] }] }];
  throw new Error("Cryptorefills: unknown route (demo)");
}

export function demoCryptorefillsOrder(path: string, body: { deliveries?: { brand_name: string; denomination: string; product_value?: number }[] }): Record<string, unknown> {
  const d = body.deliveries?.[0];
  const item = CR.find((c) => c.brand === d?.brand_name && (c.price === null ? d?.denomination === "range" : String(c.price) === d?.denomination));
  if (!d || !item) return { problems: [{ problem: "PRODUCT_NOT_FOUND" }] };
  const price = item.price ?? Number(d.product_value);
  const amount = (Math.round(price * 1.002 * 100) / 100).toFixed(2);
  if (path === "/v5/orders/validations") return { coin: "USDC", coin_amount: amount };
  return { order_id: randomUUID(), wallet_address: FAKE_EVM, coin_amount: amount, coin: "USDC", network: "Base", expiration_date: new Date(Date.now() + 15 * 60_000).toISOString() };
}
export const demoCryptorefillsState = (orderId: string) => ({ order_state: paidFor(orderId) ? "Done" : "WaitingForPayment" });

// ---------- Credible Finance ----------
const accounts = new Map<string, { bank_account_id: string; account_number: string; ifsc: string; account_holder_name: string; bank_name: string }[]>();
export function demoCredible(area: "onramp" | "offramp", method: string, path: string, data: Record<string, string | number | boolean>): unknown {
  const on = area === "onramp";
  if (path === "/currency-pairs") {
    return { data: [on
      ? { pair_id: "demo-inr-usdc-base", input_currency: "INR", output_currency: "USDC", blockchain: "Base", min_output_amount: 5, max_output_amount: 2000, fee_bps: 50, processing_time_min: 2, processing_time_max: 10 }
      : { pair_id: "demo-usdc-inr-base", input_currency: "USDC", output_currency: "INR", blockchain: "Base", min_input_amount: 5, max_input_amount: 1000, fee_bps: 50, processing_time_min: 5, processing_time_max: 30 }] };
  }
  if (path === "/rate") return { data: on ? { rate: 83.5, fee_input: 20, network_fee_input: 10, expires_at: nowSec() + 300 } : { rate: 82.5, fee_input: 0.5, network_fee_input: 0.5, expires_at: nowSec() + 300 } };
  if (on && path === "/createOrder") {
    const inr = Number(data.amount);
    const intent = `upi://pay?pa=demo@bluvfi&pn=Credible%20Demo&am=${inr}&cu=INR&tn=demo`;
    return { data: { order_id: demoId("on"), upi_qr: intent, upi_intent: intent, input_amount: inr, expires_at: nowSec() + 15 * 60 } };
  }
  if (on && path === "/order") {
    const id = String(data.order_id);
    const r = state().receivables.find((x) => x.bank?.orderId === id);
    const age = r ? Date.now() - Date.parse(r.createdAt) : 0;
    return { data: { order_id: id, status: r?.status === "paid" ? "COMPLETED" : age > 20_000 ? "PAYMENT_RECEIVED" : "CREATED" } };
  }
  const mine = () => { const k = currentBiz(); if (!accounts.has(k)) accounts.set(k, []); return accounts.get(k)!; };
  if (!on && path === "/bank-accounts" && method === "GET") return { data: mine() };
  if (!on && path === "/bank-accounts" && method === "POST") {
    const num = String(data.account_number);
    const a = { bank_account_id: demoId("ba"), account_number: `XXXX${num.slice(-4)}`, ifsc: String(data.ifsc), account_holder_name: `${data.first_name} ${data.last_name}`, bank_name: "Demo Bank" };
    mine().push(a);
    return { data: a };
  }
  if (!on && path === "/createOrder") {
    const usdc = Number(data.amount);
    return { data: { order_id: demoId("off"), deposit_address: FAKE_EVM, blockchain: "Base", input_amount: usdc, input_currency: "USDC", output_amount: Math.floor((usdc - 1) * 82.5 * 100) / 100, expires_at: nowSec() + 15 * 60 } };
  }
  if (!on && path === "/order") return { data: { order_id: String(data.order_id), status: paidFor(String(data.order_id)) ? "PAYOUT_COMPLETED" : "DEPOSIT_PENDING" } };
  throw new Error("Credible Finance: unknown route (demo)");
}
export const resetDemoBank = () => accounts.clear();

// ---------- Backpack Exchange ----------
/**
 * Every US stock and ETF Backpack lists, with a recent price, from the copy saved in fixtures/backpack-stocks.json
 * (Backpack's /api/v1/securities and External tickers). Demo trades stay fractional (0.01 share) so a small demo buy fills.
 */
const FALLBACK: [string, string, number][] = [["AAPL", "Apple Inc.", 228], ["MSFT", "Microsoft Corp.", 431], ["NVDA", "NVIDIA Corp.", 142], ["TSLA", "Tesla Inc.", 251], ["SPY", "SPDR S&P 500 ETF", 589], ["QQQ", "Invesco QQQ Trust", 502]];
let savedStocks: [string, string, number][] | undefined;
function stocksList(): [string, string, number][] {
  if (savedStocks) return savedStocks;
  try {
    const rows = (JSON.parse(readFileSync(join(process.cwd(), "fixtures", "backpack-stocks.json"), "utf8")) as { stocks: [string, string, number][] }).stocks;
    savedStocks = rows.filter((r) => /^[A-Z0-9.]{1,10}$/.test(r[0]) && r[2] > 0).map(([t, n, p]): [string, string, number] => [t, n, p]);
  } catch {
    savedStocks = [];
  }
  if (!savedStocks.length) savedStocks = FALLBACK;
  return savedStocks;
}
/** A steady, slightly moving price: the same answer for the same minute. */
export function demoStockPrice(asset: string, atMs = Date.now()): number {
  const base = stocksList().find((s) => `${s[0]}.US` === asset)?.[2] ?? 100;
  return Math.round(base * (1 + 0.012 * Math.sin(atMs / 3_600_000 + unit(asset) * 6)) * 100) / 100;
}
const wallets = new Map<string, { cash: number; shares: Record<string, number>; credited: Set<string> }>();
const fills = new Map<string, { qty: number; quote: number }>();
const wallet = () => { const k = currentBiz(); if (!wallets.has(k)) wallets.set(k, { cash: 0, shares: {}, credited: new Set() }); return wallets.get(k)!; };
export const resetDemoStocks = () => { wallets.clear(); fills.clear(); };

export function demoBackpackPublic(path: string, params: Record<string, string | number | boolean | undefined>): unknown {
  if (path === "/api/v1/securities") return stocksList().map(([t, name]) => ({ asset: `${t}.US`, name, sessions: [{ minQuantity: "0.01", stepSize: "0.01" }] }));
  if (path === "/api/v1/tickers") return stocksList().map(([t]) => ({ symbol: `${t}.US_USDC`, lastPrice: String(demoStockPrice(`${t}.US`)), priceChangePercent: String(Math.round((unit(t, Math.floor(Date.now() / 86_400_000)) - 0.5) * 0.05 * 10_000) / 10_000) }));
  if (path === "/api/v1/market-sessions") return [{ name: "demo", startTime: "00:00:00", endTime: "23:59:59", startWeekday: 1, endWeekday: 7, timezone: "America/New_York" }];
  if (path === "/api/v1/market-holidays") return [];
  if (path === "/api/v1/markets") return stocksList().map(([t]) => ({ symbol: `${t}.US_USDC`, rwaMarketType: "STOCK", marketType: "SPOT" }));
  if (path === "/api/v1/klines") {
    const asset = String(params.symbol ?? "").replace(/_USDC$/, "");
    const hourly = params.interval === "1h";
    const step = hourly ? 3_600_000 : 86_400_000;
    const from = Number(params.startTime) * 1000;
    const rows: { start: string; close: string }[] = [];
    for (let t = Math.ceil(from / step) * step; t < Date.now(); t += step) rows.push({ start: new Date(t).toISOString().replace("T", " ").slice(0, 19), close: demoStockPrice(asset, t).toFixed(2) });
    return rows;
  }
  throw new Error("Backpack: unknown route (demo)");
}

export function demoBackpackSigned(method: string, path: string, params: Record<string, string | number | boolean | undefined>): unknown {
  const w = wallet();
  // The account's cash is what the treasury has paid in (approved funding payments), less what trades spent.
  for (const p of state().payments) if (p.invoice.issuedBy === "backpack" && p.status === "paid" && !w.credited.has(p.id)) { w.credited.add(p.id); w.cash += p.invoice.amountUsd; }
  if (path === "/wapi/v1/capital/deposit/address") return { address: FAKE_EVM };
  if (path === "/api/v1/capital") {
    return { USDC: { available: w.cash.toFixed(2), locked: "0" }, ...Object.fromEntries(Object.entries(w.shares).filter(([, q]) => q > 0).map(([a, q]) => [a, { available: String(q), locked: "0" }])) };
  }
  if ((path === "/api/v1/rfq" || path === "/api/v1/order") && method === "POST") {
    const asset = String(params.symbol).replace(/_USDC(_RFQ)?$/, "");
    const qty = Number(params.quantity);
    const price = demoStockPrice(asset);
    const buy = params.side === "Bid";
    if (buy ? price > Number(params.price) : price < Number(params.price)) return path === "/api/v1/order" ? { status: "Expired", executedQuantity: "0", executedQuoteQuantity: "0" } : { rfqId: "0", status: "Expired" };
    w.cash += buy ? -qty * price : qty * price;
    w.shares[asset] = Math.round(((w.shares[asset] ?? 0) + (buy ? qty : -qty)) * 1e6) / 1e6;
    const rfqId = demoId("rfq");
    fills.set(rfqId, { qty, quote: Math.round(qty * price * 100) / 100 });
    return path === "/api/v1/order" ? { status: "Filled", executedQuantity: String(qty), executedQuoteQuantity: (Math.round(qty * price * 100) / 100).toFixed(2) } : { rfqId, status: "New" };
  }
  if (path === "/wapi/v1/history/rfq/fill") { const f = fills.get(String(params.rfqId)); return f ? [{ fillQuantity: String(f.qty), fillQuoteQuantity: f.quote.toFixed(2) }] : []; }
  throw new Error("Backpack: unknown route (demo)");
}
