import { createHmac } from "node:crypto";
import { processInvoice, seal } from "./agent";
import { cfg } from "./business";
import { createFundingLink } from "./fund";
import { services } from "./services";
import { state } from "./store";
import { currentBiz, needLive } from "./tenant";
import type { Confidentiality, Invoice, Payment, Receivable } from "./types";

/**
 * INR bank transfers in and out of the treasury, through Credible Finance (UPI rails). Each business brings its own Credible account
 * (Settings; the operator's own business reads CREDIBLE_FINANCE_API_KEY and CREDIBLE_FINANCE_API_SECRET), so the money and the compliance
 * checks are between the business and Credible, never held here.
 *
 *  - Add money (on-ramp): the business pays INR by UPI, Credible buys USDC and sends it to a NEAR Intents deposit address made for this one
 *    funding, and NEAR Intents turns it into USDC in the treasury, the same trick as the card funding. A refund, if the swap fails, goes to a
 *    wallet address the person gives.
 *  - Cash out (off-ramp): Credible makes an order with a deposit address; the treasury pays USDC to it as an ordinary payment (policy,
 *    fraud checks and the council's approval all apply), and Credible pays INR to the bank account. The address, amount and deadline are
 *    Credible's own answer to our call, checked here and trusted for that one thing.
 *
 * Bank account numbers go straight to Credible, which keeps them: nothing here stores one. Built to Credible's API as the Bluvfi app's
 * backend uses it. Credible only answers from IP addresses its customer has allowed, so run it from an allowed address.
 */
const BASE = (process.env.CREDIBLE_BASE ?? "https://api.credible.finance").replace(/\/$/, "");
const MIN_MINUTES_TO_PAY = 3;
const DEFAULT_WINDOW_MINUTES = 15;
/** The most one cash-out may be, in USDC. */
const maxCashOutUsd = () => (Number(process.env.CREDIBLE_MAX_CASHOUT_USD) > 0 ? Number(process.env.CREDIBLE_MAX_CASHOUT_USD) : 5_000);

export type BankChain = "base" | "arb" | "eth" | "sol";
export interface BankPair { pairId: string; input: string; output: string; chain: BankChain; chainName: string; min: number; max: number; feeBps: number; minutes: [number, number] }
export class CredibleError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); this.name = "CredibleError"; }
}

const ADDRESS: Record<BankChain, RegExp> = { base: /^0x[0-9a-fA-F]{40}$/, arb: /^0x[0-9a-fA-F]{40}$/, eth: /^0x[0-9a-fA-F]{40}$/, sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
/** Credible names blockchains its own way; only the chains NEAR Intents can reach (for USDC) are usable. */
export function chainOf(name: string): BankChain | null {
  const n = name.trim().toLowerCase();
  if (n === "base") return "base";
  if (["arb", "arbitrum", "arbitrum one"].includes(n)) return "arb";
  if (["eth", "ethereum", "erc20", "evm", "mainnet"].includes(n)) return "eth";
  if (["sol", "solana"].includes(n)) return "sol";
  return null;
}

// ---------- Credible's signed requests ----------
function keys(): { key: string; secret: string } {
  const c = cfg();
  if (!c.CREDIBLE_API_KEY || !c.CREDIBLE_API_SECRET) throw new CredibleError("This business has no Credible Finance account connected. Add its API key and secret on the Settings page.", 400);
  return { key: c.CREDIBLE_API_KEY, secret: c.CREDIBLE_API_SECRET };
}
export const bankingConfigured = () => { const c = cfg(); return !!(c.CREDIBLE_API_KEY && c.CREDIBLE_API_SECRET); };

/** Credible signs the request's own string and number fields, sorted by name, with a nonce and a receive window. */
export function sign(params: Record<string, string | number>, nonce: number, recvWindow: number, secret: string): string {
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return createHmac("sha256", secret).update(`${sorted}&nonce=${nonce}&recv_window=${recvWindow}`).digest("hex");
}

async function call<T>(area: "onramp" | "offramp", method: "GET" | "POST", path: string, data: Record<string, string | number | boolean> = {}): Promise<T> {
  const { key, secret } = keys();
  const nonce = Date.now();
  const signed: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(data)) if (typeof v === "string" || typeof v === "number") signed[k] = v;
  const qs = method === "GET" && Object.keys(data).length ? `?${new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]))}` : "";
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-API-KEY": key, "X-NONCE": String(nonce), "X-RECV-WINDOW": "5000", "X-SIGNATURE": sign(signed, nonce, 5000, secret) };
  if (method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
  const send = () => fetch(`${BASE}/${area}${path}${qs}`, { method, headers, body: method === "POST" ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(20_000) });
  // A dropped connection is tried once more with the same signature and idempotency key, so an order cannot be made twice.
  const res = await send().catch(() => send());
  const text = await res.text();
  let j: unknown = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const o = (j ?? {}) as { message?: string; error?: string; error_code?: string };
    if (o.error_code === "IP_ADDRESS_NOT_ALLOWED") throw new CredibleError("Credible Finance does not accept requests from this server's IP address. Add it to the allowed addresses in the Credible dashboard.", res.status);
    throw new CredibleError(`Credible Finance ${res.status}: ${o.message ?? o.error ?? text.slice(0, 160)}`, res.status);
  }
  return j as T;
}
const unwrap = <T>(j: unknown): T => ((j as { data?: T })?.data ?? j) as T;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : NaN);
/** Credible's `expires_at` is a unix time, in seconds (or milliseconds): read either. */
const when = (v: unknown): number => { const n = num(v); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN; };

/** The customer Credible knows this business as. */
export const customerId = () => `bluvfi-${currentBiz()}`;

// ---------- Pairs and rates ----------
interface RawPair { pair_id: string; input_currency: string; output_currency: string; blockchain: string; min_output_amount?: number; max_output_amount?: number; min_input_amount?: number; max_input_amount?: number; fee_bps?: number; processing_time_min?: number; processing_time_max?: number }
function toPair(r: RawPair, side: "on" | "off"): BankPair | null {
  const chain = chainOf(r.blockchain ?? "");
  const crypto = (side === "on" ? r.output_currency : r.input_currency) ?? "";
  const fiat = (side === "on" ? r.input_currency : r.output_currency) ?? "";
  if (!chain || crypto.toUpperCase() !== "USDC" || fiat.toUpperCase() !== "INR" || !r.pair_id) return null;
  return {
    pairId: r.pair_id, input: r.input_currency.toUpperCase(), output: r.output_currency.toUpperCase(), chain, chainName: r.blockchain,
    min: num(side === "on" ? r.min_output_amount : r.min_input_amount) || 0, max: num(side === "on" ? r.max_output_amount : r.max_input_amount) || Infinity,
    feeBps: num(r.fee_bps) || 0, minutes: [num(r.processing_time_min) || 0, num(r.processing_time_max) || 0],
  };
}
/** INR to USDC pairs that deliver to a chain NEAR Intents can bring into the treasury. Others are left out. */
export async function onrampPairs(): Promise<BankPair[]> {
  return (unwrap<RawPair[]>(await call("onramp", "GET", "/currency-pairs")) ?? []).map((r) => toPair(r, "on")).filter((p): p is BankPair => !!p);
}
/** USDC to INR pairs whose deposit chain the treasury can pay. */
export async function offrampPairs(): Promise<BankPair[]> {
  return (unwrap<RawPair[]>(await call("offramp", "GET", "/currency-pairs")) ?? []).map((r) => toPair(r, "off")).filter((p): p is BankPair => !!p);
}
async function rate(area: "onramp" | "offramp", pairId: string, amount: number) {
  const q = unwrap<{ rate?: number; fee_input?: number; network_fee_input?: number; expires_at?: number }>(await call(area, "GET", "/rate", { pair_id: pairId, amount }));
  const r = num(q?.rate);
  if (!(r > 0)) throw new CredibleError("Credible Finance gave no rate for that pair", 502);
  return { rate: r, fee: num(q.fee_input) || 0, networkFee: num(q.network_fee_input) || 0, expiresAt: when(q.expires_at) };
}

/** What an INR amount buys, as USDC, after Credible's fees. The rate is read as INR per USDC. */
export function usdcFor(inr: number, q: { rate: number; fee: number; networkFee: number }): number {
  return Math.floor(((inr - q.fee - q.networkFee) / q.rate) * 100) / 100;
}
/** What a USDC amount pays, in INR, after Credible's fees (their fees are in USDC on this side). */
export function inrFor(usdc: number, q: { rate: number; fee: number; networkFee: number }): number {
  return Math.floor((usdc - q.fee - q.networkFee) * q.rate * 100) / 100;
}

export async function quoteOnramp(pairId: string, inr: number) {
  const pair = (await onrampPairs()).find((p) => p.pairId === pairId);
  if (!pair) throw new Error("That pair is not available");
  const q = await rate("onramp", pairId, inr);
  return { pair, ...q, usdc: usdcFor(inr, q) };
}
export async function quoteOfframp(pairId: string, usdc: number) {
  const pair = (await offrampPairs()).find((p) => p.pairId === pairId);
  if (!pair) throw new Error("That pair is not available");
  const q = await rate("offramp", pairId, usdc);
  return { pair, ...q, inr: inrFor(usdc, q) };
}

// ---------- Add money: INR by UPI becomes USDC in the treasury ----------
const NAME = /^[\p{L} .'-]{1,60}$/u;
export interface OnrampInput { pairId: string; amountInr: number; firstName: string; lastName: string; refundTo: string }
export async function startOnramp(input: OnrampInput): Promise<Receivable> {
  needLive("add money by bank transfer");
  if (!NAME.test(input.firstName.trim()) || !NAME.test(input.lastName.trim())) throw new Error("Give the first and last name on the bank account that will pay");
  if (!(input.amountInr > 0)) throw new Error("Give an amount in rupees");
  const pair = (await onrampPairs()).find((p) => p.pairId === input.pairId);
  if (!pair) throw new Error("That pair is not available");
  if (!ADDRESS[pair.chain].test(input.refundTo)) throw new Error(`A refund address on ${pair.chainName} is needed, in case the swap into the treasury fails`);
  const q = await rate("onramp", pair.pairId, input.amountInr);
  const usdc = usdcFor(input.amountInr, q);
  if (usdc < pair.min || usdc > pair.max) throw new Error(`That buys about ${usdc} USDC. This pair takes ${pair.min} to ${pair.max === Infinity ? "any amount" : pair.max}.`);
  if (usdc < 1) throw new Error("That is too little to put into the treasury");
  // The deposit address is made for the amount Credible will send (a little less, to be safe): NEAR Intents delivers exactly that to the treasury.
  const target = Math.floor(usdc * 0.99 * 100) / 100;
  const link = createFundingLink(target);
  let quote;
  try { quote = await services.quoteReceivable(link.amountUsd, pair.chain, input.refundTo, link.payTo); } catch (e) { state().receivables = state().receivables.filter((r) => r.id !== link.id); throw e; }
  if (!ADDRESS[pair.chain].test(quote.depositAddress)) { state().receivables = state().receivables.filter((r) => r.id !== link.id); throw new Error("NEAR Intents did not give a usable deposit address, so nothing was started"); }
  let order: { order_id?: string; upi_qr?: string; upi_intent?: string; input_amount?: number; expires_at?: number };
  try {
    order = unwrap(await call("onramp", "POST", "/createOrder", { pair_id: pair.pairId, amount: input.amountInr, customer_id: customerId(), first_name: input.firstName.trim(), last_name: input.lastName.trim(), destination_address: quote.depositAddress }));
  } catch (e) { state().receivables = state().receivables.filter((r) => r.id !== link.id); throw e; }
  if (!order?.order_id || !order.upi_intent) { state().receivables = state().receivables.filter((r) => r.id !== link.id); throw new Error("Credible Finance did not create the order"); }
  link.description = `Money put into the treasury by bank transfer (₹${input.amountInr})`;
  link.deposit = { chain: pair.chain, address: quote.depositAddress, memo: quote.depositMemo, amountIn: quote.amountIn, deadline: quote.deadline };
  const exp = when(order.expires_at);
  link.bank = { provider: "credible", orderId: order.order_id, status: "CREATED", inr: num(order.input_amount) || input.amountInr, upiIntent: order.upi_intent, upiQr: order.upi_qr ?? "", expiresAt: new Date(Number.isFinite(exp) ? exp : Date.now() + DEFAULT_WINDOW_MINUTES * 60_000).toISOString() };
  return link;
}

/** Ask Credible where a bank funding stands. NEAR Intents' own status settles the funding itself; this is what the person sees about the bank step. */
export async function refreshOnramp(r: Receivable): Promise<NonNullable<Receivable["bank"]>> {
  if (!r.bank) throw new Error("This funding was not made by bank transfer");
  const d = unwrap<{ status?: string }>(await call("onramp", "GET", "/order", { order_id: r.bank.orderId }));
  r.bank.status = String(d?.status ?? r.bank.status);
  r.bank.checkedAt = new Date().toISOString();
  return r.bank;
}

// ---------- Bank accounts (kept by Credible, never here) ----------
export interface BankAccount { id: string; bank: string; holder: string; last4: string; ifsc: string }
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{6,20}$/;
export async function listBankAccounts(): Promise<BankAccount[]> {
  const rows = unwrap<{ bank_account_id: string; account_number: string; ifsc: string; account_holder_name: string; bank_name: string }[]>(await call("offramp", "GET", "/bank-accounts", { customer_id: customerId() })) ?? [];
  return rows.map((a) => ({ id: a.bank_account_id, bank: a.bank_name, holder: a.account_holder_name, last4: String(a.account_number ?? "").slice(-4), ifsc: a.ifsc }));
}
export async function addBankAccount(i: { firstName: string; lastName: string; accountNumber: string; ifsc: string }): Promise<BankAccount> {
  const ifsc = i.ifsc.trim().toUpperCase(), accountNumber = i.accountNumber.replace(/\s/g, "");
  if (!NAME.test(i.firstName.trim()) || !NAME.test(i.lastName.trim())) throw new Error("Give the first and last name on the account");
  if (!ACCOUNT.test(accountNumber)) throw new Error("An account number is 6 to 20 digits");
  if (!IFSC.test(ifsc)) throw new Error("An IFSC code is 4 letters, a 0, then 6 letters or digits");
  const a = unwrap<{ bank_account_id: string; account_number: string; ifsc: string; account_holder_name: string; bank_name: string }>(await call("offramp", "POST", "/bank-accounts", { customer_id: customerId(), first_name: i.firstName.trim(), last_name: i.lastName.trim(), account_number: accountNumber, ifsc }));
  return { id: a.bank_account_id, bank: a.bank_name, holder: a.account_holder_name, last4: accountNumber.slice(-4), ifsc };
}

// ---------- Cash out: the treasury pays USDC, Credible pays INR ----------
export interface CashOutInput { pairId: string; amountUsdc: number; bankAccountId: string; firstName: string; lastName: string; confidentiality?: Confidentiality }
export async function cashOut(input: CashOutInput): Promise<Payment> {
  needLive("cash out to a bank");
  if (!NAME.test(input.firstName.trim()) || !NAME.test(input.lastName.trim())) throw new Error("Give the first and last name on the bank account");
  if (!(input.amountUsdc >= 1) || input.amountUsdc > maxCashOutUsd()) throw new Error(`A cash-out is from 1 to ${maxCashOutUsd().toLocaleString()} USDC`);
  const pair = (await offrampPairs()).find((p) => p.pairId === input.pairId);
  if (!pair) throw new Error("That pair is not available");
  if (input.amountUsdc < pair.min || input.amountUsdc > pair.max) throw new Error(`This pair takes ${pair.min} to ${pair.max === Infinity ? "any amount" : pair.max} USDC`);
  const account = (await listBankAccounts()).find((a) => a.id === input.bankAccountId);
  if (!account) throw new Error("Choose one of the bank accounts saved with Credible Finance");
  const q = await rate("offramp", pair.pairId, input.amountUsdc);
  const o = unwrap<{ order_id?: string; deposit_address?: string; blockchain?: string; input_amount?: number; input_currency?: string; output_amount?: number; expires_at?: number }>(
    await call("offramp", "POST", "/createOrder", { pair_id: pair.pairId, amount: input.amountUsdc, customer_id: customerId(), first_name: input.firstName.trim(), last_name: input.lastName.trim(), bank_account_id: account.id }));
  // Trust nothing in the answer that is not checked: the money goes to this address, for this amount, by this deadline.
  if (!o?.order_id) throw new Error("Credible Finance did not create the order");
  const chain = chainOf(o.blockchain ?? pair.chainName);
  if (!chain) throw new Error("Credible Finance asked for a chain the treasury cannot pay on, so nothing was sent");
  if (!o.deposit_address || !ADDRESS[chain].test(o.deposit_address)) throw new Error("Credible Finance gave no usable deposit address, so nothing was sent");
  if ((o.input_currency ?? pair.input).toUpperCase() !== "USDC") throw new Error("Credible Finance asked for something other than USDC, so nothing was sent");
  const amount = num(o.input_amount);
  if (!(amount > 0) || Math.abs(amount - input.amountUsdc) > input.amountUsdc * 0.01 + 0.01) throw new Error(`Credible Finance asked for ${o.input_amount} USDC for a ${input.amountUsdc} USDC cash-out. That is not an amount to trust, so nothing was sent.`);
  const exp = when(o.expires_at);
  const expiresAt = new Date(Number.isFinite(exp) ? exp : Date.now() + DEFAULT_WINDOW_MINUTES * 60_000).toISOString();
  if (Date.parse(expiresAt) - Date.now() < MIN_MINUTES_TO_PAY * 60_000) throw new Error("That order runs out too soon to be approved. Try again.");
  const inr = num(o.output_amount) || q.rate * (input.amountUsdc - q.fee - q.networkFee);
  const invoice: Invoice = {
    id: `bank-${Date.now()}`, vendorName: "Credible Finance", vendorDomain: "credible.finance", vendorContact: { channel: "email", handle: "support@credible.finance" },
    invoiceNumber: `CF-${o.order_id.slice(0, 8)}`, poNumber: "-", amountUsd: amount, asset: "USDC", chain, payoutAddress: o.deposit_address,
    text: `Cash out to INR: ${amount} USDC to the bank account ending ${account.last4} (about ₹${Math.round(inr).toLocaleString("en-IN")}), through Credible Finance order ${o.order_id.slice(0, 8)}.`,
    receivedAt: new Date().toISOString(), category: "banking", issuedBy: "credible", expiresAt,
  };
  return processInvoice(invoice, input.confidentiality ?? "basic", {
    bill: { provider: "credible", invoiceId: o.order_id, product: `Cash out ₹${Math.round(inr).toLocaleString("en-IN")} to ····${account.last4}`, email: "", status: "unpaid", expiresAt },
  });
}

const OFFRAMP_WORDS: Record<string, string> = { CREATED: "unpaid", DEPOSIT_PENDING: "unpaid", DEPOSIT_CONFIRMED: "pending", PAYOUT_INITIATED: "pending", PAYOUT_COMPLETED: "complete", FAILED: "failed" };
/** Ask Credible where a cash-out stands: waiting for the USDC, paying INR, done or failed. */
export async function refreshCashOut(p: Payment): Promise<NonNullable<Payment["bill"]>> {
  if (p.bill?.provider !== "credible") throw new Error("This payment is not a cash-out");
  const d = unwrap<{ status?: string; payout_utr?: string }>(await call("offramp", "GET", "/order", { order_id: p.bill.invoiceId }));
  const status = OFFRAMP_WORDS[String(d?.status ?? "")] ?? p.bill.status;
  const changed = p.bill.status !== status;
  p.bill.status = status;
  p.bill.checkedAt = new Date().toISOString();
  if (changed) seal(p);
  return p.bill;
}
