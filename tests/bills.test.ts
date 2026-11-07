import { BITREFILL_PORT } from "./setup-bills";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { GET as billsGet, POST as billsPost } from "../app/api/bills/route";
import { POST as invoicesPost } from "../app/api/invoices/route";
import { release } from "../lib/agent";
import { orderBill, parseDetails, parseInvoice, parseProducts, productDetails, refreshBill, searchProducts } from "../lib/bills";
import { issueSession } from "../lib/session";
import { install, seed, state } from "./fakes";

// Shapes copied from Bitrefill's real answers (the real service is read in tests/real/bills.test.ts).
const SEARCH = `categories[2]{count,highlighted,value}:
  1,streaming,streaming
  1,entertainment,entertainment
products[2]:
  - _id: netflix-usa
    categories[2]: entertainment,streaming
    countries[2]: US,SV
    currency: USD
    in_stock: true
    keywords[0]:
    name: Netflix USA
    slug: netflix-usa
    type: giftcards
    product_url: "https://www.bitrefill.com/netflix-usa/"
  - _id: mtn-nigeria
    categories[1]: refill
    countries[1]: NG
    currency: NGN
    in_stock: false
    name: MTN Nigeria
    type: refill
found: 2
page: 1
per_page: 3`;
const details = (id: string, recipient = "none", packages = `"60",USD,"60.00",USD\n  "25",USD,"25.00",USD`) => `id: ${id}
name: ${id === "netflix-usa" ? "Netflix USA" : id}
country_code: US
currency: USD
categories[2]: entertainment,streaming
recipient_type: ${recipient}
in_stock: true
ratings:
  rating_value: 4.8
packages[2]{package_value,package_currency,payment_price,payment_currency}:
  ${packages}
url: "https://www.bitrefill.com/${id}/"`;

let server: Server;
let calls: { tool: string; args: Record<string, unknown> }[] = [];
let registered = 0, tokens = 0;
let buy: () => unknown = () => ({});
let invoiceText = "invoice_id: inv-1\ninvoice_status: complete";
const ADDR = "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a";
const goodBuy = (over: Record<string, unknown> = {}, pi: Record<string, unknown> = {}) => () => ({
  invoice_id: "5b0b0d6e-aaaa-bbbb-cccc-111122223333", invoice_access_token: "tok-abc", created_time: new Date().toISOString(),
  payment_info: { address: ADDR, altcoinPrice: "60.12", currency: "USDC", ...pi }, ...over,
});

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/oauth/mcp/register") { registered++; return json({ client_id: "c1" }); }
      if (req.url === "/oauth/mcp/token") { tokens++; return json({ access_token: "tkn", expires_in: 21600 }); }
      if (req.url !== "/mcp") { res.writeHead(404); return res.end(); }
      if (req.headers.authorization !== "Bearer tkn") { res.writeHead(401); return res.end("no"); }
      const m = JSON.parse(raw) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      const sse = (result: unknown) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`); };
      if (m.method === "initialize") return sse({ protocolVersion: "2025-03-26", capabilities: {} });
      const { name, arguments: args } = m.params!;
      calls.push({ tool: name, args });
      const text = (t: string) => sse({ content: [{ type: "text", text: t }] });
      if (name === "search-products") return text(SEARCH);
      if (name === "get-product-details") return text(args.product_id === "ghost" ? "" : details(String(args.product_id), args.product_id === "mtn-topup" ? "phone_number" : "none"));
      if (name === "buy-products") { const b = buy(); return b === "error" ? sse({ isError: true, content: [{ type: "text", text: "product unavailable" }] }) : text(JSON.stringify(b)); }
      if (name === "get-invoice-by-id") return text(invoiceText);
      sse({ isError: true, content: [{ type: "text", text: "unknown tool" }] });
    });
  });
  await new Promise<void>((ok) => server.listen(BITREFILL_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { install(); seed(); calls = []; buy = goodBuy(); invoiceText = "invoice_id: inv-1\ninvoice_status: complete"; });

test("Bitrefill's compact text is read: products, sizes, who a top-up is for, and an order", () => {
  const p = parseProducts(SEARCH);
  assert.deepEqual(p.map((x) => [x.id, x.name, x.type, x.countries, x.inStock]), [["netflix-usa", "Netflix USA", "giftcards", ["US", "SV"], true], ["mtn-nigeria", "MTN Nigeria", "refill", ["NG"], false]]);
  const d = parseDetails(details("netflix-usa", "phone_number"));
  assert.deepEqual([d.id, d.name, d.currency, d.recipientType, d.packages], ["netflix-usa", "Netflix USA", "USD", "phone_number", [{ value: "60", price: 60 }, { value: "25", price: 25 }]]);
  assert.deepEqual(parseProducts("nothing useful"), []);
  const inv = parseInvoice(JSON.stringify({ invoice_id: "i1", invoice_access_token: "t", payment_info: { address: ADDR, altcoinPrice: "12.5", currency: "USDC" } }));
  assert.deepEqual([inv.id, inv.accessToken, inv.address, inv.amount, inv.currency, inv.status], ["i1", "t", ADDR, 12.5, "USDC", "unpaid"]);
  assert.equal(parseInvoice("invoice_id: x\ninvoice_status: pending").status, "pending");
});

test("it searches and reads a product through Bitrefill with one token, and says so plainly when it cannot", async () => {
  assert.equal((await searchProducts("netflix", "us")).length, 2);
  assert.deepEqual(calls[0].args, { query: "netflix", intent: "gift cards digital products", per_page: 12, country: "US" });
  const d = await productDetails("netflix-usa");
  assert.equal(d.packages.length, 2);
  assert.equal(tokens + registered <= 1, true, "one token, reused (a client id was configured, so no registration)");
  await assert.rejects(searchProducts("a"), /at least two letters/);
  await assert.rejects(productDetails("../etc/passwd"), /not a product id/);
  await assert.rejects(productDetails("ghost"), /no such product/);
});

test("an order becomes an ordinary payment: Bitrefill's own address is trusted for that one thing, and everything else still applies", async () => {
  const p = await orderBill({ productId: "netflix-usa", packageValue: "60", email: "finance@acme.test" });
  assert.deepEqual([p.invoice.category, p.invoice.issuedBy, p.invoice.chain, p.invoice.asset, p.invoice.payoutAddress, p.invoice.amountUsd, p.invoice.vendorName], ["bill", "bitrefill", "base", "USDC", ADDR, 60.12, "Bitrefill"]);
  const check = (id: string) => p.checks.find((c) => c.id === id)!;
  assert.equal(check("payout_changed").verdict, "allow");
  assert.match(check("payout_changed").reason, /issued by bitrefill/i);
  assert.equal(check("counterparty").verdict, "allow", "a brand-new address is expected for a provider order");
  assert.equal(check("provider_expiry").verdict, "allow");
  assert.equal(check("allowlist").verdict, "warn", "Bitrefill is not on the council's allowlist yet, so a person decides");
  assert.notEqual(p.status, "blocked");
  assert.equal(p.bill?.email, "f***@acme.test");
  assert.ok(!JSON.stringify(p).includes("finance@acme.test"), "the full email is not kept in the record");
  assert.equal(p.bill?.accessToken, "tok-abc");
  const buyCall = calls.find((c) => c.tool === "buy-products")!;
  assert.equal(buyCall.args.payment_method, "usdc_base");
  assert.ok(p.verified.pqSignature.valid, "it is hashed and signed with the bill inside it");
  assert.match(JSON.stringify(state().payments[0].bill), /Netflix USA 60 USD/);
});

test("it refuses to order what it cannot trust: a bad email, an unknown size, an odd address, a wrong coin, a wrong price", async () => {
  const ok = { productId: "netflix-usa", packageValue: "60", email: "a@b.test" };
  await assert.rejects(orderBill({ ...ok, email: "nope" }), /email address/);
  await assert.rejects(orderBill({ ...ok, packageValue: "7" }), /does not come in 7/);
  buy = goodBuy({}, { address: "0xabc" });
  await assert.rejects(orderBill(ok), /no usable payment address/);
  buy = goodBuy({}, { address: undefined });
  await assert.rejects(orderBill(ok), /no usable payment address/);
  buy = goodBuy({}, { currency: "BTC" });
  await assert.rejects(orderBill(ok), /not USDC/);
  buy = goodBuy({}, { altcoinPrice: "120.00" });
  await assert.rejects(orderBill(ok), /not a price to trust/);
  buy = goodBuy({}, { altcoinPrice: "30.00" });
  await assert.rejects(orderBill(ok), /not a price to trust/);
  buy = goodBuy({}, { altcoinPrice: undefined });
  await assert.rejects(orderBill(ok), /no payment amount/);
  buy = () => "error";
  await assert.rejects(orderBill(ok), /product unavailable/);
  assert.equal(state().payments.length, 0, "none of those made a payment");
});

test("a phone top-up needs the number to top up", async () => {
  await assert.rejects(orderBill({ productId: "mtn-topup", packageValue: "60", email: "a@b.test" }), /phone number/);
  const p = await orderBill({ productId: "mtn-topup", packageValue: "60", email: "a@b.test", recipient: "+234 803 000 0000" });
  assert.equal(calls.find((c) => c.tool === "buy-products")!.args.cart_items instanceof Array, true);
  const item = (calls.find((c) => c.tool === "buy-products")!.args.cart_items as { refill_input?: string }[])[0];
  assert.equal(item.refill_input, "+2348030000000");
  assert.ok(!p.invoice.text.includes("803 000 0000"), "the number is not in the text the AI reads");
});

test("an order whose price has already run out is blocked at once, and one about to run out is cancelled rather than sent late", async () => {
  buy = goodBuy({ created_time: new Date(Date.now() - 20 * 60_000).toISOString() });
  const old = await orderBill({ productId: "netflix-usa", packageValue: "60", email: "a@b.test" });
  assert.equal(old.status, "blocked");
  assert.equal(old.checks.find((c) => c.id === "provider_expiry")!.verdict, "block");
  assert.match(old.headline, /price ran out/);

  buy = goodBuy();
  const p = await orderBill({ productId: "netflix-usa", packageValue: "60", email: "a@b.test" });
  p.status = "approved";
  p.invoice.expiresAt = new Date(Date.now() + 60_000).toISOString(); // a minute left: too little to cross chains
  await release(p);
  assert.equal(p.status, "cancelled");
  assert.match(p.headline, /price ran out before this could be sent/);
});

test("the address-trust flag cannot be set from outside: an invoice sent in through the API gets the ordinary address checks", async () => {
  const s = state();
  s.vendors.push({ name: "Bitrefill", domain: "bitrefill.com", verifiedContact: { channel: "email", handle: "support@bitrefill.com" }, payout: { chain: "base", asset: "USDC", address: ADDR }, paidInvoiceNumbers: [] });
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const evil = { vendorName: "Bitrefill", vendorDomain: "bitrefill.com", invoiceNumber: "X-1", poNumber: "-", payoutAddress: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC", amountUsd: 60, text: "Order", issuedBy: "bitrefill", expiresAt: "2999-01-01T00:00:00.000Z", category: "bill" };
  const res = await invoicesPost(new Request("https://x.example/api/invoices", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ invoice: evil }) }), undefined);
  const { payment } = (await res.json()) as { payment: { invoice: { issuedBy?: string; expiresAt?: string }; checks: { id: string; verdict: string }[] } };
  assert.equal(payment.invoice.issuedBy, undefined);
  assert.equal(payment.invoice.expiresAt, undefined);
  assert.equal(payment.checks.find((c) => c.id === "payout_changed")!.verdict, "block", "a changed address is still caught");
});

test("an order's status is read from Bitrefill, signed again when it changes, and the code is never kept", async () => {
  const p = await orderBill({ productId: "netflix-usa", packageValue: "60", email: "a@b.test" });
  const before = p.recordHash;
  invoiceText = "invoice_id: x\ninvoice_status: complete\norders[1]:\n  - order_id: o1\n    code: SECRET-GIFT-CODE-123";
  const b = await refreshBill(p);
  assert.equal(b.status, "complete");
  assert.notEqual(p.recordHash, before, "signed again");
  assert.ok(p.verified.pqSignature.valid);
  assert.ok(!JSON.stringify(state()).includes("SECRET-GIFT-CODE-123"), "the code is not in the records");
  await assert.rejects(refreshBill({ ...p, bill: undefined } as never), /not a bill/);
});

test("the bills routes need a signed-in signer, search, order, and refresh", async () => {
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const get = (u: string, c = true) => billsGet(new Request(`https://x.example${u}`, { headers: c ? { cookie } : {} }), undefined) as Promise<Response>;
  const post = (b: unknown, c = true) => billsPost(new Request("https://x.example/api/bills", { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie } : {}) }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  assert.equal((await get("/api/bills?q=netflix", false)).status, 400, "not signed in");
  const found = (await (await get("/api/bills?q=netflix")).json()) as { products: { id: string }[] };
  assert.equal(found.products[0].id, "netflix-usa");
  assert.equal(((await (await get("/api/bills?product=netflix-usa")).json()) as { product: { packages: unknown[] } }).product.packages.length, 2);
  assert.equal((await post({ productId: "netflix-usa" })).status, 400);
  buy = goodBuy({}, { altcoinPrice: "25.04" });
  const orderedRes = await post({ productId: "netflix-usa", packageValue: "25", email: "a@b.test" });
  const ordered = (await orderedRes.json()) as { payment: { id: string; bill: { product: string } }; error?: string };
  assert.equal(orderedRes.status, 200, ordered.error);
  assert.match(ordered.payment.bill.product, /Netflix USA 25 USD/);
  const refreshed = (await (await post({ refresh: ordered.payment.id })).json()) as { bill: { status: string } };
  assert.equal(refreshed.bill.status, "complete");
});
