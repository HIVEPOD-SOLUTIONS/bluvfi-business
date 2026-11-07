import { createHash } from "node:crypto";
import { processInvoice, seal } from "./agent";
import { BILL_WINDOW_MINUTES, MIN_MINUTES_TO_PAY } from "./bills-time";
import { state } from "./store";
import { needLive } from "./tenant";
import type { Confidentiality, Invoice, Payment } from "./types";

/**
 * Pay bills: gift cards, phone top-ups and eSIM data, bought from Bitrefill with no account (the code is emailed to the address given).
 * Bitrefill is reached through its MCP server. The business never pays Bitrefill directly from the app: the order Bitrefill makes (an
 * amount and a deposit address) becomes an ordinary payment, so it goes through the same policy gate, fraud checks and treasury vote
 * as any invoice. The address comes from Bitrefill's own answer to our call, never from text a person typed, which is why it is marked
 * `issuedBy` and trusted for that one thing (a changed address is expected: every order has its own).
 *
 * One real limit: Bitrefill holds an order's price for about 15 minutes (`BILL_WINDOW_MINUTES`). A payment that cannot be sent in that
 * time is refused or cancelled, never sent late, because money sent to an expired order can be lost. Treasuries where several people must
 * vote have to vote inside that time; a spending wallet (hybrid custody) pays at once.
 */
const MCP_BASE = (process.env.BITREFILL_MCP_BASE ?? "https://api.bitrefill.com/mcp").replace(/\/$/, "");
const ORIGIN = new URL(MCP_BASE).origin;
export { BILL_WINDOW_MINUTES, MIN_MINUTES_TO_PAY };

// ---------- Talking to Bitrefill ----------
let token: { value: string; until: number } | undefined;
let clientId: string | undefined;

async function bearer(): Promise<string | undefined> {
  if (/\/mcp\/[^/]+$/.test(MCP_BASE)) return undefined; // a key in the URL path needs no token
  if (token && token.until > Date.now()) return token.value;
  clientId ??= process.env.BITREFILL_CLIENT_ID ?? ((await (await fetch(`${ORIGIN}/oauth/mcp/register`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ client_name: "bluvfi-business", grant_types: ["client_credentials"], token_endpoint_auth_method: "none", scope: "mcp", redirect_uris: [process.env.PUBLIC_BASE_URL || "https://bluvfi.xyz"] }),
  })).json()) as { client_id?: string }).client_id;
  if (!clientId) throw new Error("Bitrefill did not register this app");
  const res = await fetch(`${ORIGIN}/oauth/mcp/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, scope: "mcp", resource: MCP_BASE }).toString(),
  });
  if (!res.ok) { clientId = undefined; throw new Error(`Bitrefill would not give a token (${res.status})`); }
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
  return token.value;
}

let rpcId = 0;
/** One call to a Bitrefill tool. Its answer is JSON or a compact text format; both come back as text. */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const t = await bearer();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(t ? { authorization: `Bearer ${t}` } : {}) };
  const url = (process.env.BITREFILL_MCP_URL ?? "").trim() || MCP_BASE;
  // A dropped connection is tried once more. Asking again is safe: an order that was never paid costs nothing and simply expires.
  const post = async (body: object) => {
    const go = async () => { const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); return { r, text: await r.text() }; };
    try { return await go(); } catch { return go(); }
  };
  await post({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bluvfi-business", version: "1.0.0" } } });
  const { r, text } = await post({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  if (r.status === 401) token = undefined;
  const line = /^data: (.*)$/m.exec(text)?.[1] ?? text;
  let msg: { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
  try { msg = JSON.parse(line); } catch { throw new Error(`Bitrefill answered something unreadable (${r.status})`); }
  if (msg.error) throw new Error(`Bitrefill: ${msg.error.message ?? "error"}`);
  const out = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (msg.result?.isError) throw new Error(`Bitrefill: ${out.slice(0, 200) || "the request was refused"}`);
  return out;
}

// ---------- Reading its compact text ----------
const unquote = (s: string) => { const t = s.trim(); return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t; };
const csv = (line: string) => { const out: string[] = []; let cur = ""; let q = false; for (const c of line) { if (c === '"') q = !q; else if (c === "," && !q) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out.map((x) => x.trim()); };
/** `key: value` lines at the top level, with `name[3]: a,b,c` read as a list. */
function flat(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][\w]*)(?:\[\d+\])?:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = /^[A-Za-z_]\w*\[\d+\]:/.test(line) ? (m[2] ? m[2].split(",").map(unquote) : []) : unquote(m[2]);
  }
  return out;
}

export interface BillProduct { id: string; name: string; type: string; countries: string[]; categories: string[]; inStock: boolean }
export interface BillPackage { value: string; price: number }
export interface BillProductDetails extends BillProduct { currency: string; recipientType: string; packages: BillPackage[]; range?: { min: number; max: number } }

export function parseProducts(text: string): BillProduct[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^products\[\d+\]:/.test(l));
  if (start < 0) return [];
  const items: Record<string, string | string[]>[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const first = /^\s+- ([A-Za-z_]\w*)(?:\[\d+\])?:\s*(.*)$/.exec(line);
    const more = /^\s{4}([A-Za-z_]\w*)(?:\[\d+\])?:\s*(.*)$/.exec(line);
    const m = first ?? more;
    if (!m) continue;
    if (first) items.push({});
    items[items.length - 1][m[1]] = /\[\d+\]:/.test(line) ? (m[2] ? m[2].split(",").map(unquote) : []) : unquote(m[2]);
  }
  return items.map((i) => ({
    id: String(i._id ?? i.slug ?? ""), name: String(i.name ?? i._id ?? ""), type: String(i.type ?? ""),
    countries: Array.isArray(i.countries) ? i.countries : [], categories: Array.isArray(i.categories) ? i.categories : [], inStock: i.in_stock !== "false",
  })).filter((p) => p.id);
}

export function parseDetails(text: string): BillProductDetails {
  const f = flat(text);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^packages\[\d+\]\{/.test(l));
  const packages: BillPackage[] = [];
  if (at >= 0) {
    const cols = /\{(.*)\}/.exec(lines[at])![1].split(",");
    const vi = cols.indexOf("package_value"), pi = cols.indexOf("payment_price");
    for (const line of lines.slice(at + 1)) {
      if (/^\S/.test(line)) break;
      const c = csv(line.trim());
      const price = Number(c[pi]);
      if (c[vi] && Number.isFinite(price) && price > 0) packages.push({ value: unquote(c[vi]), price });
    }
  }
  const min = Number(f.range_min ?? f.min_value), max = Number(f.range_max ?? f.max_value);
  return {
    id: String(f.id ?? ""), name: String(f.name ?? f.id ?? ""), type: String(f.type ?? ""), currency: String(f.currency ?? "USD"),
    recipientType: String(f.recipient_type ?? "none"), countries: f.country_code ? [String(f.country_code)] : [], categories: Array.isArray(f.categories) ? f.categories : [],
    inStock: f.in_stock !== "false", packages, ...(Number.isFinite(min) && Number.isFinite(max) && max >= min && max > 0 ? { range: { min, max } } : {}),
  };
}

export async function searchProducts(query: string, country?: string, limit = 12): Promise<BillProduct[]> {
  const q = query.trim();
  if (q.length < 2) throw new Error("Type at least two letters to search");
  const text = await callTool("search-products", { query: q.slice(0, 80), intent: "gift cards digital products", per_page: Math.min(limit, 25), ...(country ? { country: country.toUpperCase().slice(0, 2) } : {}) });
  return parseProducts(text);
}

export async function productDetails(id: string): Promise<BillProductDetails> {
  if (!/^[a-z0-9._-]{2,80}$/i.test(id)) throw new Error("That is not a product id");
  const d = parseDetails(await callTool("get-product-details", { product_id: id, currency: "USD" }));
  if (!d.id) throw new Error("Bitrefill has no such product");
  return d;
}

// ---------- An order ----------
export interface BillInvoice { id: string; accessToken?: string; status: string; address?: string; amount?: number; currency?: string; createdAt?: string; expiresInMinutes?: number }

export function parseInvoice(text: string): BillInvoice {
  let o: Record<string, unknown> | undefined;
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { /* the compact text format */ }
  if (o) {
    const inv = ((o.response ?? o.invoice ?? o.data ?? o) as Record<string, unknown>);
    const pi = (inv.payment_info ?? {}) as Record<string, unknown>;
    const amount = Number(pi.altcoinPrice ?? pi.amount ?? NaN);
    return {
      id: String(inv.invoice_id ?? inv.id ?? ""), accessToken: (inv.invoice_access_token ?? o.invoice_access_token) as string | undefined, status: String(inv.invoice_status ?? inv.status ?? "unpaid"),
      address: typeof pi.address === "string" ? pi.address : undefined, amount: Number.isFinite(amount) ? amount : undefined, currency: typeof pi.currency === "string" ? pi.currency : undefined,
      createdAt: (inv.created_time ?? inv.createdTime) as string | undefined, expiresInMinutes: Number(inv.expiration_minutes ?? NaN) || undefined,
    };
  }
  const f = flat(text);
  return { id: String(f.invoice_id ?? ""), status: String(f.invoice_status ?? "unknown"), address: typeof f.address === "string" ? f.address : undefined };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9]{7,15}$/;
const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");

export interface BillOrderInput { productId: string; packageValue: string; email: string; recipient?: string; confidentiality?: Confidentiality }

/**
 * Order a bill. Asks Bitrefill for the order, checks what it says, and turns it into a payment that the policy and the treasury still
 * decide. Returns that payment. Nothing is sent from here.
 */
export async function orderBill(input: BillOrderInput): Promise<Payment> {
  needLive("order bills");
  if (!EMAIL.test(input.email)) throw new Error("Give an email address for the receipt and the code");
  const d = await productDetails(input.productId);
  if (!d.inStock) throw new Error(`${d.name} is out of stock`);
  const pkg = d.packages.find((p) => p.value === input.packageValue);
  const flexible = !pkg && d.range && Number(input.packageValue) >= d.range.min && Number(input.packageValue) <= d.range.max;
  if (!pkg && !flexible) throw new Error(`${d.name} does not come in ${input.packageValue}`);
  const price = pkg?.price ?? Number(input.packageValue);
  if (d.recipientType === "phone_number" && !PHONE.test((input.recipient ?? "").replace(/[\s()-]/g, ""))) throw new Error("Give the phone number to top up, with the country code");
  if (d.recipientType !== "none" && d.recipientType !== "phone_number" && !input.recipient?.trim()) throw new Error(`Give the ${d.recipientType.replace("_", " ")} to top up`);

  const text = await callTool("buy-products", {
    cart_items: [{ product_id: d.id, package_value: input.packageValue, ...(d.recipientType !== "none" && input.recipient ? { refill_input: input.recipient.replace(/[\s()-]/g, "").slice(0, 100) } : {}), gift: { recipient_email: input.email, recipient_name: input.email.split("@")[0], sender_name: "Bluvfi Business" } }],
    payment_method: "usdc_base", email: input.email, return_payment_link: false,
  });
  const inv = parseInvoice(text);
  // Trust nothing in the answer that is not checked: the money goes to this address, for this amount.
  if (!inv.id) throw new Error("Bitrefill did not create the order");
  if (!inv.address || !/^0x[0-9a-fA-F]{40}$/.test(inv.address)) throw new Error("Bitrefill gave no usable payment address, so nothing was ordered");
  if (!(inv.amount && inv.amount > 0)) throw new Error("Bitrefill gave no payment amount, so nothing was ordered");
  if (inv.currency && !/^usdc/i.test(inv.currency)) throw new Error(`Bitrefill asked for ${inv.currency}, not USDC, so nothing was ordered`);
  if (inv.amount < price * 0.97 || inv.amount > price * 1.05 + 0.5) throw new Error(`Bitrefill asked for $${inv.amount} for a $${price} product. That is not a price to trust, so nothing was ordered.`);
  const created = inv.createdAt ? Date.parse(inv.createdAt) : NaN;
  const expiresAt = new Date((Number.isFinite(created) ? created : Date.now()) + (inv.expiresInMinutes ?? BILL_WINDOW_MINUTES) * 60_000).toISOString();

  const invoice: Invoice = {
    id: `bill-${Date.now()}`, vendorName: "Bitrefill", vendorDomain: "bitrefill.com", vendorContact: { channel: "email", handle: "support@bitrefill.com" },
    invoiceNumber: `BR-${inv.id.slice(0, 8)}`, poNumber: "-", amountUsd: inv.amount, asset: "USDC", chain: "base", payoutAddress: inv.address,
    text: `Bitrefill order: ${d.name} ${input.packageValue} ${d.currency}${input.recipient ? ` for ${input.recipient.slice(0, 4)}…` : ""}. Receipt and code to ${maskEmail(input.email)}.`,
    receivedAt: new Date().toISOString(), category: "bill", issuedBy: "bitrefill", expiresAt,
  };
  return processInvoice(invoice, input.confidentiality ?? "basic", {
    bill: { provider: "bitrefill", invoiceId: inv.id, accessToken: inv.accessToken, product: `${d.name} ${input.packageValue} ${d.currency}`, email: maskEmail(input.email), status: inv.status, expiresAt },
  });
}

/** Ask Bitrefill where an order stands (paid, delivered, expired) and record it. The code itself is only ever emailed, never kept here. */
export async function refreshBill(p: Payment): Promise<NonNullable<Payment["bill"]>> {
  if (!p.bill) throw new Error("This payment is not a bill");
  if (p.bill.provider === "credible") return (await import("./banking")).refreshCashOut(p);
  if (p.bill.provider === "cryptorefills") return (await import("./cryptorefills")).refreshCryptorefills(p);
  const text = await callTool("get-invoice-by-id", { invoice_id: p.bill.invoiceId, ...(p.bill.accessToken ? { invoice_access_token: p.bill.accessToken } : {}) });
  const f = parseInvoice(text);
  const changed = p.bill.status !== f.status;
  p.bill.status = f.status;
  p.bill.checkedAt = new Date().toISOString();
  if (changed) seal(p); // the record is signed over what it says, so a change is signed again
  return p.bill;
}

/** Bills still waiting on delivery: asked about by the scheduled settlement poll. */
export async function refreshOpenBills(): Promise<number> {
  let n = 0;
  for (const p of state().payments) {
    if (p.bill && p.status === "paid" && !["complete", "denied", "expired", "failed"].includes(p.bill.status)) {
      try { await refreshBill(p); n++; } catch { /* asked again next time */ }
    }
  }
  return n;
}

export const billRef = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);
