import { CR_PORT } from "./setup-cr";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { GET as billsGet, POST as billsPost } from "../app/api/bills/route";
import { refreshBill } from "../lib/bills";
import { listBrands, listProducts, normaliseStatus, orderCryptorefills, paymentNetworks, refreshCryptorefills } from "../lib/cryptorefills";
import { issueSession } from "../lib/session";
import { install, seed, state } from "./fakes";

const EVM = "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a";
const BRANDS = [{ brand_name: "Amazon", family: "Amazon", category: "Shopping", min: "10", max: "500" }, { brand_name: "Netflix", family: "Netflix", category: "Streaming" }, { brand_name: "MTN Nigeria", family: "MTN", category: "Mobile top-up" }];
const CATALOG = [
  { product_id: "amz-25", product_name: "Amazon 25 USD", brand_name: "Amazon", denomination: "25 USD", denomination_label: "$25", currency: "USD", is_range: false, price_usdc: "25.10" },
  { product_id: "amz-range", product_name: "Amazon any amount", brand_name: "Amazon", denomination: "range", currency: "USD", is_range: true, price_usdc: "variable", min_value: 10, max_value: 200 },
];
const VIAS = [{ name: "USER_WALLET", available: true, currencies: [{ name: "USDC", networks: [{ name: "ETH Mainnet" }, { name: "Solana" }, { name: "Base" }, { name: "Sui" }, { name: "Arbitrum", is_suspended: true }] }, { name: "USDT", networks: [{ name: "Tron" }] }] }, { name: "CARD", currencies: [] }];

let server: Server;
let hits: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let validation: () => object = () => ({});
let created: () => object = () => ({});
let orderState = "WaitingForPayment";
const goodValidation = () => ({ coin: "USDC", coin_amount: "25.10" });
const goodOrder = (over: Record<string, unknown> = {}) => () => ({ order_id: "cr-order-123456", wallet_address: EVM, coin_amount: "25.12", coin: "USDC", network: "Base", expiration_date: new Date(Date.now() + 20 * 60_000).toISOString(), ...over });

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/v1/brands") return json(200, u.searchParams.get("country_code") === "zz" ? [] : BRANDS);
      if (u.pathname === "/v1/catalog") return json(200, u.searchParams.get("brand_name") === "Amazon" ? CATALOG : []);
      if (u.pathname === "/partner/v3/payment_vias") return json(200, VIAS);
      if (u.pathname === "/partner/v5/orders/validations") return json(200, validation());
      if (u.pathname === "/partner/v5/orders" && req.method === "POST") return json(200, created());
      if (u.pathname.startsWith("/partner/v5/orders/")) return json(200, { order_id: "cr-order-123456", order_state: orderState });
      json(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(CR_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { install(); seed(); hits = []; validation = goodValidation; created = goodOrder(); orderState = "WaitingForPayment"; process.env.CRYPTOREFILLS_PARTNER_ID = "test-partner-id"; });

const order = (over: Record<string, unknown> = {}) => orderCryptorefills({ country: "US", brand: "Amazon", productId: "amz-25", beneficiary: "friend@example.com", email: "finance@acme.test", user: { ip: "203.0.113.9", userAgent: "TestAgent/1.0" }, ...over } as never);

test("brands and products are read from the catalogue: searched, mapped, and ranges understood", async () => {
  assert.deepEqual((await listBrands("us", "net")).map((b) => b.name), ["Netflix"]);
  assert.equal((await listBrands("us")).length, 3);
  await assert.rejects(listBrands("usa"), /two-letter country code/);
  const p = await listProducts("US", "Amazon");
  assert.deepEqual([p[0].productId, p[0].label, p[0].priceUsd, p[0].isRange], ["amz-25", "$25", 25.1, false]);
  assert.deepEqual([p[1].isRange, p[1].priceUsd, p[1].min, p[1].max], [true, null, 10, 200]);
});

test("it pays only in USDC on a chain NEAR Intents can reach, Base first, and ignores suspended or unreachable networks", async () => {
  const nets = await paymentNetworks();
  assert.deepEqual(nets.map((n) => n.chain), ["base", "eth", "sol"], "Arbitrum is suspended, Sui and Tron cannot be paid from here");
});

test("an order is a dry run first, then the order, and becomes an ordinary payment with the address Cryptorefills gave", async () => {
  const p = await order();
  const paths = hits.filter((h) => h.url.includes("/partner/v5/orders")).map((h) => h.url.replace("/partner", ""));
  assert.deepEqual(paths, ["/v5/orders/validations", "/v5/orders"], "checked before it was created");
  const create = hits.find((h) => h.url === "/partner/v5/orders" && h.method === "POST")!;
  assert.deepEqual([create.headers["x-cr-application"], create.headers["x-forwarded-for"], create.headers["user-agent"]], ["test-partner-id", "203.0.113.9", "TestAgent/1.0"], "who is buying is passed on, as Cryptorefills requires");
  assert.deepEqual(create.body.payment, { type: "via", payment_via: "USER_WALLET", coin: "USDC", network: "Base" });
  assert.equal(create.body.deliveries[0].beneficiary_account, "friend@example.com");
  assert.deepEqual([p.invoice.category, p.invoice.issuedBy, p.invoice.chain, p.invoice.asset, p.invoice.payoutAddress, p.invoice.amountUsd, p.invoice.vendorName], ["bill", "cryptorefills", "base", "USDC", EVM, 25.12, "Cryptorefills"]);
  assert.equal(p.checks.find((c) => c.id === "payout_changed")!.verdict, "allow");
  assert.equal(p.checks.find((c) => c.id === "provider_expiry")!.verdict, "allow");
  assert.deepEqual([p.bill?.provider, p.bill?.invoiceId, p.bill?.status, p.bill?.email], ["cryptorefills", "cr-order-123456", "unpaid", "f***@acme.test"]);
  assert.ok(!JSON.stringify(p).includes("finance@acme.test") && !p.invoice.text.includes("friend@example.com"), "the whole email addresses are not in the record");
  assert.ok(p.verified.pqSignature.valid);
});

test("a range product takes an amount inside its limits only", async () => {
  await assert.rejects(order({ productId: "amz-range", productValue: 5 }), /from 10 to 200/);
  await assert.rejects(order({ productId: "amz-range" }), /from 10 to 200/);
  validation = () => ({ coin: "USDC", coin_amount: "50.20" }); created = goodOrder({ coin_amount: "50.22" });
  const p = await order({ productId: "amz-range", productValue: 50 });
  const create = hits.find((h) => h.url === "/partner/v5/orders" && h.method === "POST")!;
  assert.deepEqual([create.body.deliveries[0].denomination, create.body.deliveries[0].product_value], ["range", 50]);
  assert.equal(p.invoice.amountUsd, 50.22);
});

test("it refuses to order what it cannot trust, and says why", async () => {
  await assert.rejects(order({ email: "nope" }), /email address/);
  await assert.rejects(order({ beneficiary: " " }), /Say who it is for/);
  await assert.rejects(order({ productId: "ghost" }), /not in Cryptorefills' catalogue/);
  created = goodOrder({ wallet_address: "0xabc" });
  await assert.rejects(order(), /no usable payment address/);
  created = goodOrder({ wallet_address: undefined });
  await assert.rejects(order(), /no usable payment address/);
  created = goodOrder({ coin: "BTC" });
  await assert.rejects(order(), /not USDC/);
  created = goodOrder({ coin_amount: "40.00" });
  await assert.rejects(order(), /changed the price between checking and ordering/);
  validation = () => ({ coin: "USDC", coin_amount: "100.00" }); created = goodOrder({ coin_amount: "100.00" });
  await assert.rejects(order(), /not a price to trust/);
  validation = () => ({ coin: "USDC", coin_amount: "700.00" }); created = goodOrder({ coin_amount: "700.00" });
  await assert.rejects(order({ productId: "amz-range", productValue: 200 }), /over the \$500 limit/);
  validation = () => ({ problems: [{ problem: "OUT_OF_STOCK" }] });
  hits = [];
  await assert.rejects(order(), /OUT_OF_STOCK/);
  assert.equal(hits.some((h) => h.url === "/partner/v5/orders" && h.method === "POST"), false, "nothing was created after a failed check");
  assert.equal(state().payments.length, 0, "none of those made a payment");
});

test("without a partner id it says what is missing and creates nothing", async () => {
  delete process.env.CRYPTOREFILLS_PARTNER_ID;
  await assert.rejects(order(), /CRYPTOREFILLS_PARTNER_ID/);
  assert.equal(hits.filter((h) => h.url.includes("/partner/v5/orders")).length, 0);
});

test("an order whose time has run out is blocked at once, and one with no stated deadline gets the short default", async () => {
  created = goodOrder({ expiration_date: new Date(Date.now() - 60_000).toISOString() });
  const old = await order();
  assert.equal(old.status, "blocked");
  assert.match(old.headline, /price ran out/);
  created = goodOrder({ expiration_date: undefined });
  const p = await order();
  const left = (Date.parse(p.bill!.expiresAt) - Date.now()) / 60_000;
  assert.ok(left > 13 && left <= 15.1, `about 15 minutes, got ${left}`);
});

test("an order's state is read from Cryptorefills, in the Bills page's words, signed again when it changes, and the code is never kept", async () => {
  const p = await order();
  const before = p.recordHash;
  assert.deepEqual(["Done", "Expired", "Refunded", "WaitingForManualAction", "PaymentReceived", "WaitingForPayment", undefined].map((s) => normaliseStatus(s, undefined)), ["complete", "expired", "failed", "pending", "payment_confirmed", "unpaid", "unpaid"]);
  orderState = "Done";
  const b = await refreshBill(p); // the Bitrefill-era entry point picks the right provider
  assert.equal(b.status, "complete");
  assert.notEqual(p.recordHash, before, "signed again");
  assert.ok(p.verified.pqSignature.valid);
  await assert.rejects(refreshCryptorefills({ ...p, bill: { ...p.bill!, provider: "bitrefill" } } as never), /not a Cryptorefills order/);
});

test("the bills routes serve Cryptorefills: brands, products, and an order that passes the buyer's address on", async () => {
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const get = (u: string) => billsGet(new Request(`https://x.example${u}`, { headers: { cookie } }), undefined) as Promise<Response>;
  const post = (b: unknown) => billsPost(new Request("https://x.example/api/bills", { method: "POST", headers: { "content-type": "application/json", cookie, "x-forwarded-for": "198.51.100.7, 10.0.0.1", "user-agent": "Browser/9" }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  const brands = (await (await get("/api/bills?provider=cryptorefills&country=US&q=amaz")).json()) as { brands: { name: string }[]; configured: boolean; networks: { chain: string }[] };
  assert.deepEqual([brands.brands.map((b) => b.name), brands.configured, brands.networks[0].chain], [["Amazon"], true, "base"]);
  const products = (await (await get("/api/bills?provider=cryptorefills&country=US&brand=Amazon")).json()) as { products: { productId: string }[] };
  assert.equal(products.products.length, 2);
  assert.equal((await post({ provider: "cryptorefills", country: "US", brand: "Amazon", productId: "amz-25", email: "a@b.test" })).status, 400, "who it is for is required");
  const res = await post({ provider: "cryptorefills", country: "US", brand: "Amazon", productId: "amz-25", beneficiary: "x@y.test", email: "a@b.test" });
  assert.equal(res.status, 200);
  const create = hits.find((h) => h.url === "/partner/v5/orders" && h.method === "POST")!;
  assert.deepEqual([create.headers["x-forwarded-for"], create.headers["user-agent"]], ["198.51.100.7", "Browser/9"]);
  const out = (await res.json()) as { payment: { bill: { provider: string } } };
  assert.equal(out.payment.bill.provider, "cryptorefills");
});
