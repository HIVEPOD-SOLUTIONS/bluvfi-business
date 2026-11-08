import { processInvoice, seal } from "./agent";
import { MIN_MINUTES_TO_PAY } from "./bills-time";
import { demoCryptorefillsGet, demoCryptorefillsOrder, demoCryptorefillsState } from "./demo-providers";
import { isDemo } from "./tenant";
import type { Confidentiality, Invoice, Payment } from "./types";

/**
 * Pay bills with Cryptorefills: gift cards, phone top-ups and eSIM data, bought by paying USDC to a deposit address Cryptorefills makes for the
 * order (its partner API, `CRYPTOREFILLS_PARTNER_ID`, free with any Cryptorefills account). Like every bill, the order becomes an ordinary payment:
 * the address and amount are Cryptorefills' own answer to our call (checked, and trusted for that one thing), and the policy, the fraud
 * checks and the treasury's approval still decide it. The order's deadline is Cryptorefills' own; a payment that cannot be sent in time is
 * refused or cancelled, never sent late.
 */
const HOST = (process.env.CRYPTOREFILLS_HOST ?? "https://x402.cryptorefills.com").replace(/\/$/, "");
const PARTNER = (process.env.CRYPTOREFILLS_PARTNER_HOST ?? "https://api.cryptorefills.com").replace(/\/$/, "");
const partnerId = () => (process.env.CRYPTOREFILLS_PARTNER_ID ?? "").trim();
/** The most one order may cost. */
const maxOrderUsd = () => (Number(process.env.CRYPTOREFILLS_MAX_ORDER_USD) > 0 ? Number(process.env.CRYPTOREFILLS_MAX_ORDER_USD) : 500);
/** When Cryptorefills gives no deadline for an order, assume the shortest sensible one. */
const DEFAULT_WINDOW_MINUTES = 15;

export interface CrBrand { name: string; family: string; category: string; min?: string; max?: string }
export interface CrProduct { productId: string; name: string; denomination: string; label: string; currency: string; isRange: boolean; priceUsd: number | null; min?: number; max?: number }
export interface CrNetwork { coin: string; network: string; chain: "base" | "arb" | "eth" | "sol" }

export class CryptorefillsError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string | null) { super(message); this.name = "CryptorefillsError"; }
}

// ---------- Discovery (the catalogue changes slowly) ----------
const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
  const key = isDemo() ? `demo:${name}` : name; // demo fixtures never answer a live business
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return data;
}

async function getJson<T>(base: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (isDemo()) return demoCryptorefillsGet(path, params) as T;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await fetch(`${base}${path}${qs.size ? `?${qs}` : ""}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { message?: string; error?: string; code?: string; detail?: string } | null;
    throw new CryptorefillsError(res.status === 403 ? "Cryptorefills refused this server's request (403). It may block this network." : (b?.message ?? b?.detail ?? b?.error ?? `Cryptorefills answered ${res.status}`), res.status, b?.code ?? null);
  }
  return (await res.json()) as T;
}

const cc = (country: string) => { const c = country.trim().toLowerCase(); if (!/^[a-z]{2}$/.test(c)) throw new Error("Give a two-letter country code, like US or NG"); return c; };

export async function listBrands(country: string, query = ""): Promise<CrBrand[]> {
  const c = cc(country);
  const all = await cached(`brands:${c}`, async () => (await getJson<{ brand_name: string; family: string; category: string; min?: string; max?: string }[]>(HOST, "/v1/brands", { country_code: c })).map((b) => ({ name: b.brand_name, family: b.family, category: b.category, min: b.min, max: b.max })));
  const q = query.trim().toLowerCase();
  return (q ? all.filter((b) => `${b.name} ${b.family} ${b.category}`.toLowerCase().includes(q)) : all).slice(0, 40);
}

export async function listProducts(country: string, brand: string): Promise<CrProduct[]> {
  const c = cc(country);
  if (!brand.trim() || brand.length > 80) throw new Error("Choose a brand");
  const items = await cached(`catalog:${c}:${brand}`, () => getJson<{ product_id: string; product_name?: string; brand_name: string; denomination?: string; denomination_label?: string; currency?: string; is_range?: boolean; price_usdc?: string; min_value?: number; max_value?: number }[]>(HOST, "/v1/catalog", { country_code: c, brand_name: brand }));
  return items.map((i) => {
    const price = Number(i.price_usdc);
    return { productId: i.product_id, name: i.product_name ?? i.brand_name, denomination: i.denomination ?? "", label: i.denomination_label ?? i.denomination ?? i.product_name ?? "", currency: i.currency ?? "USD", isRange: !!i.is_range || i.price_usdc === "variable", priceUsd: Number.isFinite(price) && price > 0 ? price : null, min: i.min_value, max: i.max_value };
  });
}

// ---------- How to pay: USDC on a chain NEAR Intents can reach ----------
const CHAIN_OF: Record<string, CrNetwork["chain"]> = { Base: "base", Arbitrum: "arb", "ETH Mainnet": "eth", Solana: "sol" };
const PREFERRED: CrNetwork["chain"][] = ["base", "arb", "eth", "sol"];

/** The USDC networks Cryptorefills takes for a payment from a wallet, restricted to the chains NEAR Intents can deliver to. Public data. */
export async function paymentNetworks(): Promise<CrNetwork[]> {
  return cached("vias", async () => {
    const vias = await getJson<{ name: string; available?: boolean; currencies?: { name: string; is_suspended?: boolean; networks?: { name: string; is_suspended?: boolean }[] }[] }[]>(PARTNER, "/v3/payment_vias");
    const out: CrNetwork[] = [];
    for (const v of vias) {
      if (v.name !== "USER_WALLET" || v.available === false) continue;
      for (const c of v.currencies ?? []) {
        if (c.name !== "USDC" || c.is_suspended) continue;
        for (const n of c.networks ?? []) if (!n.is_suspended && CHAIN_OF[n.name]) out.push({ coin: "USDC", network: n.name, chain: CHAIN_OF[n.name] });
      }
    }
    return out.sort((a, b) => PREFERRED.indexOf(a.chain) - PREFERRED.indexOf(b.chain));
  });
}

// ---------- An order ----------
export interface CrOrderInput { country: string; brand: string; productId: string; productValue?: number; beneficiary: string; email: string; user: { ip: string; userAgent: string }; confidentiality?: Confidentiality }
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
const ADDRESS: Record<CrNetwork["chain"], RegExp> = { base: /^0x[0-9a-fA-F]{40}$/, arb: /^0x[0-9a-fA-F]{40}$/, eth: /^0x[0-9a-fA-F]{40}$/, sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };

function partnerBody(i: CrOrderInput, p: CrProduct, net: CrNetwork) {
  return {
    email: i.email, user: { email: i.email, has_accepted_newsletter: false },
    payment: { type: "via", payment_via: "USER_WALLET", coin: net.coin, network: net.network },
    deliveries: [{ beneficiary_account: i.beneficiary.trim(), brand_name: i.brand, country_code: i.country.toUpperCase(), denomination: p.isRange ? "range" : p.denomination, ...(p.isRange ? { product_value: i.productValue } : {}) }],
    lang: "en", acquisition: { utm_source: "bluvfi-business" },
  };
}

async function partner(path: string, body: unknown, user: CrOrderInput["user"]): Promise<Record<string, unknown>> {
  if (isDemo()) {
    const j = demoCryptorefillsOrder(path, body as never);
    const problem = (j.problems as { problem?: string }[] | undefined)?.[0]?.problem;
    if (problem) throw new CryptorefillsError(problem, 422, problem);
    return j;
  }
  const id = partnerId();
  if (!id) throw new CryptorefillsError("Cryptorefills is not set up: add a CRYPTOREFILLS_PARTNER_ID (free with any Cryptorefills account)", 501, "PARTNER_NOT_CONFIGURED");
  const res = await fetch(`${PARTNER}${path}`, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(20_000), body: JSON.stringify(body),
    headers: { accept: "application/json", "content-type": "application/json", "x-cr-application": id, "x-cr-version": "bluvfi-business-1.0", "x-forwarded-for": user.ip, "user-agent": user.userAgent },
  });
  const j = (await res.json().catch(() => null)) as (Record<string, unknown> & { problems?: { problem?: string }[]; reason?: string; detail?: string }) | null;
  if (!res.ok || !j) throw new CryptorefillsError(String(j?.reason ?? j?.problems?.[0]?.problem ?? j?.detail ?? `Cryptorefills answered ${res.status}`), res.status, j?.problems?.[0]?.problem ?? null);
  const problem = j.problems?.[0]?.problem;
  if (problem) throw new CryptorefillsError(problem, 422, problem);
  return j;
}
const pick = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) { const v = o[k]; if (typeof v === "string" || typeof v === "number") return String(v); } return undefined; };

/**
 * Order a bill from Cryptorefills. A dry run first (same checks as a real order, nothing created), then the order; what Cryptorefills answers (a
 * USDC address and amount) is checked, and becomes a payment that the policy and the treasury still decide. Returns that payment. Nothing is sent.
 */
export async function orderCryptorefills(input: CrOrderInput): Promise<Payment> {
  if (!EMAIL.test(input.email)) throw new Error("Give an email address for the receipt and the code");
  if (!input.beneficiary?.trim() || input.beneficiary.length > 120) throw new Error("Say who it is for: the email or phone number the card or top-up goes to");
  const product = (await listProducts(input.country, input.brand)).find((p) => p.productId === input.productId);
  if (!product) throw new Error("That product is not in Cryptorefills' catalogue for this country");
  if (product.isRange && !(Number(input.productValue) >= (product.min ?? 0) && Number(input.productValue) <= (product.max ?? Infinity))) throw new Error(`Choose an amount from ${product.min} to ${product.max} ${product.currency}`);
  const nets = await paymentNetworks();
  const net = nets[0];
  if (!net) throw new Error("Cryptorefills takes no USDC on a chain NEAR Intents can pay right now. Try later.");

  const body = partnerBody(input, product, net);
  const checked = await partner("/v5/orders/validations", body, input.user); // a dry run: nothing is created
  const expected = Number(pick(checked, "coin_amount", "amount"));
  const created = await partner("/v5/orders", body, input.user);
  const orderId = pick(created, "order_id", "id", "reference_order_id");
  const address = pick(created, "wallet_address", "address");
  const amount = Number(pick(created, "coin_amount", "amount"));
  const coin = pick(created, "coin") ?? net.coin;
  // Trust nothing in the answer that is not checked: the money goes to this address, for this amount.
  if (!orderId) throw new Error("Cryptorefills did not create the order");
  if (!address || !ADDRESS[net.chain].test(address)) throw new Error("Cryptorefills gave no usable payment address, so nothing was ordered");
  if (!(amount > 0)) throw new Error("Cryptorefills gave no payment amount, so nothing was ordered");
  if (!/^usdc$/i.test(coin)) throw new Error(`Cryptorefills asked for ${coin}, not USDC, so nothing was ordered`);
  if (amount > maxOrderUsd()) throw new Error(`That order is $${amount}, over the $${maxOrderUsd()} limit for one order`);
  if (Number.isFinite(expected) && expected > 0 && (amount < expected * 0.97 || amount > expected * 1.03 + 0.5)) throw new Error("Cryptorefills changed the price between checking and ordering, so nothing was ordered");
  const face = product.isRange ? Number(input.productValue) : product.priceUsd;
  if (face && product.currency === "USD" && (amount < face * 0.9 || amount > face * 1.1 + 1)) throw new Error(`Cryptorefills asked for $${amount} for a $${face} product. That is not a price to trust, so nothing was ordered.`);
  const expiresRaw = pick(created, "expiration_date", "expires_at", "expiration_time", "expired_at");
  const expiresMs = expiresRaw ? Date.parse(expiresRaw) : NaN;
  const expiresAt = new Date(Number.isFinite(expiresMs) ? expiresMs : Date.now() + DEFAULT_WINDOW_MINUTES * 60_000).toISOString();

  const invoice: Invoice = {
    id: `bill-${Date.now()}`, vendorName: "Cryptorefills", vendorDomain: "cryptorefills.com", vendorContact: { channel: "email", handle: "support@cryptorefills.com" },
    invoiceNumber: `CR-${orderId.slice(0, 8)}`, poNumber: "-", amountUsd: amount, asset: "USDC", chain: net.chain, payoutAddress: address,
    text: `Cryptorefills order: ${product.name} ${product.label} (${input.country.toUpperCase()}) for ${input.beneficiary.trim().slice(0, 3)}…. Receipt and code to ${maskEmail(input.email)}.`,
    receivedAt: new Date().toISOString(), category: "bill", issuedBy: "cryptorefills", expiresAt,
  };
  return processInvoice(invoice, input.confidentiality ?? "basic", {
    bill: { provider: "cryptorefills", invoiceId: orderId, product: `${product.name} ${product.label}`, email: maskEmail(input.email), status: "unpaid", expiresAt },
  });
}

/** Cryptorefills' own words for an order's state, in the vocabulary the Bills page uses. */
export function normaliseStatus(orderState: string | undefined, paymentState: string | undefined): string {
  const s = orderState ?? "";
  if (s === "Done") return "complete";
  if (s === "Expired") return "expired";
  if (["PaymentFailed", "PaymentSetupFailed", "Refunded", "Canceled", "Cancelled"].includes(s)) return "failed";
  if (s === "WaitingForManualAction") return "pending";
  if (["PaymentReceived", "WaitingForDelivery"].includes(s) || paymentState === "PaymentReceived") return "payment_confirmed";
  return "unpaid";
}

/** Ask Cryptorefills where an order stands and record it, signing the record again if it changed. The code is only ever emailed, never kept. */
export async function refreshCryptorefills(p: Payment): Promise<NonNullable<Payment["bill"]>> {
  if (p.bill?.provider !== "cryptorefills") throw new Error("This payment is not a Cryptorefills order");
  let b: { order_state?: string; payment_state?: string };
  if (isDemo()) b = demoCryptorefillsState(p.bill.invoiceId);
  else {
    const id = partnerId();
    if (!id) throw new CryptorefillsError("Cryptorefills is not set up", 501, "PARTNER_NOT_CONFIGURED");
    const res = await fetch(`${PARTNER}/v5/orders/${encodeURIComponent(p.bill.invoiceId)}`, { headers: { accept: "application/json", "x-cr-application": id, "x-cr-version": "bluvfi-business-1.0" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new CryptorefillsError(`Cryptorefills answered ${res.status}`, res.status, null);
    b = (await res.json()) as { order_state?: string; payment_state?: string };
  }
  const status = normaliseStatus(b.order_state, b.payment_state);
  const changed = p.bill.status !== status;
  p.bill.status = status;
  p.bill.checkedAt = new Date().toISOString();
  if (changed) seal(p);
  return p.bill;
}

export { MIN_MINUTES_TO_PAY };
export const cryptorefillsConfigured = () => isDemo() || !!partnerId();
