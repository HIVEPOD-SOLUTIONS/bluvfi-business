import { BANK_PORT } from "./setup-bank";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { GET as bankGet, POST as bankPost } from "../app/api/banking/route";
import { addBankAccount, cashOut, chainOf, inrFor, listBankAccounts, offrampPairs, onrampPairs, refreshCashOut, refreshOnramp, sign, startOnramp, usdcFor } from "../lib/banking";
import { refreshBill } from "../lib/bills";
import { services } from "../lib/services";
import { issueSession } from "../lib/session";
import { install, seed, state } from "./fakes";

const EVM = "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a";
const MINE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ON_PAIRS = [
  { pair_id: "inr-usdc-base", input_currency: "INR", output_currency: "USDC", blockchain: "Base", min_output_amount: 5, max_output_amount: 2000, fee_bps: 50, processing_time_min: 2, processing_time_max: 10 },
  { pair_id: "inr-usdc-poly", input_currency: "INR", output_currency: "USDC", blockchain: "Polygon", min_output_amount: 5, max_output_amount: 2000 },
  { pair_id: "inr-btc-eth", input_currency: "INR", output_currency: "BTC", blockchain: "Ethereum", min_output_amount: 0, max_output_amount: 1 },
];
const OFF_PAIRS = [
  { pair_id: "usdc-inr-base", input_currency: "USDC", output_currency: "INR", blockchain: "Base", min_input_amount: 5, max_input_amount: 1000, fee_bps: 50 },
  { pair_id: "usdc-inr-tron", input_currency: "USDC", output_currency: "INR", blockchain: "Tron", min_input_amount: 5, max_input_amount: 1000 },
];

let server: Server;
let hits: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let offOrder: () => object = () => ({});
let offStatus = "DEPOSIT_PENDING";
let rejectIp = false;
const goodOff = (over: Record<string, unknown> = {}) => () => ({ data: { order_id: "cf-order-abcdef12", deposit_address: EVM, blockchain: "Base", input_amount: 100, input_currency: "USDC", output_amount: 8200, expires_at: Math.floor(Date.now() / 1000) + 20 * 60, ...over } });

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (rejectIp) return json(403, { error_code: "IP_ADDRESS_NOT_ALLOWED", message: "IP address not allowed: 1.2.3.4" });
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/onramp/currency-pairs") return json(200, { data: ON_PAIRS });
      if (u.pathname === "/offramp/currency-pairs") return json(200, { data: OFF_PAIRS });
      if (u.pathname === "/onramp/rate") return json(200, { data: { rate: 90, fee_input: 20, network_fee_input: 10, expires_at: Math.floor(Date.now() / 1000) + 300 } });
      if (u.pathname === "/offramp/rate") return json(200, { data: { rate: 82, fee_input: 0.5, network_fee_input: 0.5, expires_at: Math.floor(Date.now() / 1000) + 300 } });
      if (u.pathname === "/onramp/createOrder") return json(200, { data: { order_id: "cf-on-1234567", upi_qr: "upi://pay?qr=1", upi_intent: "upi://pay?pa=x@y&am=5000", input_amount: req.method === "POST" ? JSON.parse(raw).amount : 0, expires_at: Math.floor(Date.now() / 1000) + 900 } });
      if (u.pathname === "/onramp/order") return json(200, { data: { order_id: "cf-on-1234567", status: "PAYMENT_RECEIVED" } });
      if (u.pathname === "/offramp/bank-accounts" && req.method === "GET") return json(200, { data: [{ bank_account_id: "ba-1", account_number: "000012345678", ifsc: "HDFC0001234", account_holder_name: "Asha Rao", bank_name: "HDFC Bank" }] });
      if (u.pathname === "/offramp/bank-accounts" && req.method === "POST") return json(200, { data: { bank_account_id: "ba-2", account_number: "XXXX9999", ifsc: JSON.parse(raw).ifsc, account_holder_name: "Asha Rao", bank_name: "ICICI Bank" } });
      if (u.pathname === "/offramp/createOrder") return json(200, offOrder());
      if (u.pathname === "/offramp/order") return json(200, { data: { order_id: "cf-order-abcdef12", status: offStatus } });
      json(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(BANK_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => {
  install(); seed(); hits = []; offOrder = goodOff(); offStatus = "DEPOSIT_PENDING"; rejectIp = false;
  process.env.CREDIBLE_FINANCE_API_KEY = "test-credible-key";
  services.quoteReceivable = async (amount: number, chain: string) => ({ depositAddress: chain === "sol" ? "So11111111111111111111111111111111111111112" : EVM, amountIn: (amount * 1.002).toFixed(2), amountOut: amount.toFixed(2), deadline: new Date(Date.now() + 3_600_000).toISOString(), source: "1click" as const });
});

test("requests are signed the way Credible expects: sorted fields, a nonce and a window, HMAC-SHA256", () => {
  const expected = createHmac("sha256", "s3cret").update("a=1&b=two&nonce=1700000000000&recv_window=5000").digest("hex");
  assert.equal(sign({ b: "two", a: 1 }, 1700000000000, 5000, "s3cret"), expected);
});

test("chains are named Credible's way and only the ones NEAR Intents can reach are used", () => {
  assert.deepEqual(["Base", "Arbitrum", "Ethereum", "Solana", "Polygon", "Tron"].map(chainOf), ["base", "arb", "eth", "sol", null, null]);
});

test("the money maths reads the rate as rupees per USDC and takes the fees off", () => {
  assert.equal(usdcFor(5000, { rate: 90, fee: 20, networkFee: 10 }), 55.22);
  assert.equal(inrFor(100, { rate: 82, fee: 0.5, networkFee: 0.5 }), 8118);
});

test("only USDC and INR pairs on a reachable chain are offered, each side", async () => {
  assert.deepEqual((await onrampPairs()).map((p) => [p.pairId, p.chain]), [["inr-usdc-base", "base"]]);
  assert.deepEqual((await offrampPairs()).map((p) => [p.pairId, p.chain]), [["usdc-inr-base", "base"]]);
  const h = hits[0];
  assert.deepEqual([h.headers["x-api-key"], typeof h.headers["x-signature"], h.headers["x-recv-window"]], ["test-credible-key", "string", "5000"]);
  assert.equal(h.headers["idempotency-key"], undefined, "reads carry no idempotency key");
});

test("adding money makes a funding link, a deposit address for the amount Credible will send, and points Credible's USDC at that address", async () => {
  const r = await startOnramp({ pairId: "inr-usdc-base", amountInr: 5000, firstName: "Asha", lastName: "Rao", refundTo: MINE });
  const create = hits.find((h) => h.url === "/onramp/createOrder")!;
  assert.equal(create.body.destination_address, EVM, "Credible sends to the NEAR Intents deposit address, not to a person");
  assert.equal(create.body.customer_id, "bluvfi-default");
  assert.ok(create.headers["idempotency-key"], "an order carries an idempotency key");
  assert.deepEqual([r.kind, r.amountUsd, r.deposit?.address, r.bank?.orderId, r.bank?.inr, r.bank?.upiIntent.startsWith("upi://")], ["funding", 54.66, EVM, "cf-on-1234567", 5000, true]);
  assert.equal(state().receivables[0].id, r.id);
  assert.equal((await refreshOnramp(r)).status, "PAYMENT_RECEIVED");
});

test("an on-ramp that cannot be trusted starts nothing and leaves no funding link behind", async () => {
  const start = (o: Record<string, unknown> = {}) => startOnramp({ pairId: "inr-usdc-base", amountInr: 5000, firstName: "Asha", lastName: "Rao", refundTo: MINE, ...o });
  await assert.rejects(start({ refundTo: "near" }), /refund address on Base/);
  await assert.rejects(start({ firstName: "" }), /first and last name/);
  await assert.rejects(start({ amountInr: 0 }), /amount in rupees/);
  await assert.rejects(start({ pairId: "ghost" }), /not available/);
  await assert.rejects(start({ amountInr: 100 }), /too little|takes 5/);
  services.quoteReceivable = async () => ({ depositAddress: "nope", amountIn: "54", amountOut: "54", source: "1click" as const });
  await assert.rejects(start(), /usable deposit address/);
  assert.equal(state().receivables.length, 0, "none of those left a funding link");
  assert.equal(hits.filter((h) => h.url === "/onramp/createOrder").length, 0, "Credible was never asked to create an order");
});

test("bank accounts are listed from Credible with only the last four digits, and saved there without being kept here", async () => {
  const list = await listBankAccounts();
  assert.deepEqual(list.map((a) => [a.id, a.last4, a.bank]), [["ba-1", "5678", "HDFC Bank"]]);
  assert.ok(!JSON.stringify(list).includes("000012345678"), "the full number is not passed on");
  const a = await addBankAccount({ firstName: "Asha", lastName: "Rao", accountNumber: "123456789999", ifsc: "icic0000123" });
  assert.deepEqual([a.id, a.last4, a.ifsc], ["ba-2", "9999", "ICIC0000123"]);
  assert.ok(!JSON.stringify(state()).includes("123456789999"), "the number is not in any record here");
  await assert.rejects(addBankAccount({ firstName: "A", lastName: "R", accountNumber: "12", ifsc: "ICIC0000123" }), /6 to 20 digits/);
  await assert.rejects(addBankAccount({ firstName: "A", lastName: "R", accountNumber: "123456", ifsc: "nope" }), /IFSC/);
});

const out = (o: Record<string, unknown> = {}) => cashOut({ pairId: "usdc-inr-base", amountUsdc: 100, bankAccountId: "ba-1", firstName: "Asha", lastName: "Rao", ...o });

test("a cash-out becomes an ordinary payment of USDC to the deposit address Credible gave, checked first", async () => {
  const p = await out();
  assert.deepEqual([p.invoice.category, p.invoice.issuedBy, p.invoice.chain, p.invoice.asset, p.invoice.payoutAddress, p.invoice.amountUsd, p.invoice.vendorName], ["banking", "credible", "base", "USDC", EVM, 100, "Credible Finance"]);
  assert.equal(p.checks.find((c) => c.id === "payout_changed")!.verdict, "allow");
  assert.equal(p.checks.find((c) => c.id === "provider_expiry")!.verdict, "allow");
  assert.deepEqual([p.bill?.provider, p.bill?.invoiceId, p.bill?.status], ["credible", "cf-order-abcdef12", "unpaid"]);
  assert.match(p.bill!.product, /····5678/);
  assert.ok(!JSON.stringify(p).includes("000012345678"), "the account number is nowhere in the payment");
  assert.ok(p.verified.pqSignature.valid);
  const create = hits.find((h) => h.url === "/offramp/createOrder")!;
  assert.deepEqual([create.body.bank_account_id, create.body.customer_id], ["ba-1", "bluvfi-default"]);
});

test("a cash-out whose answer cannot be trusted sends nothing", async () => {
  offOrder = goodOff({ deposit_address: "0xabc" });
  await assert.rejects(out(), /no usable deposit address/);
  offOrder = goodOff({ deposit_address: undefined });
  await assert.rejects(out(), /no usable deposit address/);
  offOrder = goodOff({ blockchain: "Tron" });
  await assert.rejects(out(), /chain the treasury cannot pay on/);
  offOrder = goodOff({ input_currency: "USDT" });
  await assert.rejects(out(), /other than USDC/);
  offOrder = goodOff({ input_amount: 130 });
  await assert.rejects(out(), /not an amount to trust/);
  offOrder = goodOff({ expires_at: Math.floor(Date.now() / 1000) + 60 });
  await assert.rejects(out(), /runs out too soon/);
  offOrder = goodOff();
  await assert.rejects(out({ bankAccountId: "someone-elses" }), /saved with Credible/);
  await assert.rejects(out({ amountUsdc: 0.5 }), /from 1 to/);
  await assert.rejects(out({ amountUsdc: 2 }), /takes 5 to 1000/);
  await assert.rejects(out({ firstName: "" }), /first and last name/);
  assert.equal(state().payments.length, 0, "none of those made a payment");
});

test("where a cash-out stands is read from Credible, through the same refresh as bills", async () => {
  const p = await out();
  offStatus = "DEPOSIT_CONFIRMED";
  assert.equal((await refreshCashOut(p)).status, "pending");
  offStatus = "PAYOUT_COMPLETED";
  assert.equal((await refreshBill(p)).status, "complete");
  offStatus = "FAILED";
  assert.equal((await refreshCashOut(p)).status, "failed");
  assert.ok(p.verified.pqSignature.valid, "the record is signed again after a change");
});

test("the route needs a signed-in person and a connected account, and says what to do when Credible refuses this server", async () => {
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const get = (q = "", signed = true) => bankGet(new Request(`https://x.example/api/banking${q}`, { headers: signed ? { cookie } : {} }), undefined) as Promise<Response>;
  assert.equal((await get("", false)).status, 400);
  const ok = (await (await get()).json()) as { configured: boolean; on: unknown[]; off: unknown[]; accounts: unknown[] };
  assert.deepEqual([ok.configured, ok.on.length, ok.off.length, ok.accounts.length], [true, 1, 1, 1]);
  const q = (await (await get("?quote=off&pair=usdc-inr-base&amount=100")).json()) as { inr: number };
  assert.equal(q.inr, 8118);
  rejectIp = true;
  const blocked = await get();
  assert.equal(blocked.status, 400);
  assert.match(((await blocked.json()) as { error: string }).error, /allowed addresses in the Credible dashboard/);
  rejectIp = false;
  const post = (b: unknown) => bankPost(new Request("https://x.example/api/banking", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  const made = await post({ action: "cashout", pairId: "usdc-inr-base", amountUsdc: 100, bankAccountId: "ba-1", firstName: "Asha", lastName: "Rao" });
  assert.equal(made.status, 200);
  assert.equal(((await made.json()) as { payment: { bill: { provider: string } } }).payment.bill.provider, "credible");
  assert.equal((await post({ action: "nope" })).status, 400);
});
