import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { GET as modeGet, POST as modePost } from "../app/api/mode/route";
import { orderBill, productDetails, refreshBill, searchProducts } from "../lib/bills";
import { addBankAccount, bankingConfigured, cashOut, onrampPairs, startOnramp } from "../lib/banking";
import { listBrands, orderCryptorefills } from "../lib/cryptorefills";
import { cfg, createBusiness, resetRegistry, setTreasury, type Business } from "../lib/business";
import { account, fundAccount, listStocks, stockChart, trade } from "../lib/stocks";
import { COOKIE, issueSession, privySubject } from "../lib/session";
import { services } from "../lib/services";
import { currentPolicy, resetAllState, state } from "../lib/store";
import { isDemo, modeOf, resetModes, runAs, setMode } from "../lib/tenant";

beforeEach(() => { resetAllState(); resetRegistry(); resetModes(); });

let n = 0;
const req = (body: unknown, cookie?: string, method = "POST") =>
  new Request("http://app.test/api/mode", { method, headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++n % 250}`, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body) });
const as = async (b: Business, email: string) => encodeURIComponent((await issueSession(privySubject(b.id, email)))!);

test("a business that has not chosen follows how this copy was started, and a choice is its own", () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  assert.equal(modeOf(a.id), "live", "this copy was not started in demo");
  setMode(a.id, "demo");
  assert.deepEqual([modeOf(a.id), modeOf(b.id)], ["demo", "live"]);
  assert.deepEqual([runAs(a.id, isDemo), runAs(b.id, isDemo)], [true, false]);
});

test("demo and live keep separate records for the same business, and each comes back when switched back", () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  runAs(a.id, () => { state().vendors.push({ name: "Live Vendor" } as never); });
  setMode(a.id, "demo");
  runAs(a.id, () => { assert.deepEqual(state().vendors, [], "demo starts empty and does not see live records"); state().vendors.push({ name: "Demo Vendor" } as never); });
  setMode(a.id, "live");
  runAs(a.id, () => assert.deepEqual(state().vendors.map((v) => v.name), ["Live Vendor"], "live never sees demo records"));
  setMode(a.id, "demo");
  runAs(a.id, () => assert.deepEqual(state().vendors.map((v) => v.name), ["Demo Vendor"]));
});

test("a business in demo uses the simulated DAO and treasury and none of its own keys; live uses its own settings", () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  setTreasury(a.id, { custody: "manual", treasury: "acme.near" });
  assert.deepEqual(runAs(a.id, () => [cfg().TREASURY_ACCOUNT, cfg().CUSTODY]), ["acme.near", "manual"]);
  setMode(a.id, "demo");
  const d = runAs(a.id, () => cfg());
  assert.deepEqual([d.TREASURY_ACCOUNT, d.DAO_ACCOUNT, d.CUSTODY, d.AGENT_PRIVATE_KEY, d.OUTLAYER_API_KEY, d.CREDIBLE_API_KEY, d.BACKPACK_API_SECRET, d.STRIPE_SECRET_KEY], ["bluvfi-demo.near", "bluvfi-demo.sputnik-dao.near", "sputnik", "", "", "", "", ""]);
  assert.equal(d.POLICY_VIA_DAO, false);
});

test("what a business calls follows its mode: fixtures in demo, the real services (or a test's) in live", () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const liveFn = runAs(a.id, () => services.treasuryBalances);
  setMode(a.id, "demo");
  const demoFn = runAs(a.id, () => services.treasuryBalances);
  assert.notEqual(demoFn, liveFn);
  setMode(a.id, "live");
  assert.equal(runAs(a.id, () => services.treasuryBalances), liveFn);
});

test("a business in demo can use bills, bank transfers and stocks on fixtures, and never touches the network", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  setMode(a.id, "demo");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("the network was used in demo"); }) as typeof fetch;
  try {
    await runAs(a.id, async () => {
      // Bitrefill: search, sizes, an order that becomes an ordinary payment, and its status once the simulated DAO has paid it.
      assert.deepEqual((await searchProducts("netflix")).map((p) => p.id), ["netflix-usa"]);
      assert.deepEqual((await productDetails("netflix-usa")).packages.map((p) => p.value), ["15", "30", "60"]);
      const bill = await orderBill({ productId: "netflix-usa", packageValue: "30", email: "pat@acme.test" });
      assert.deepEqual([bill.invoice.issuedBy, bill.invoice.chain, bill.invoice.amountUsd, bill.bill?.status], ["bitrefill", "base", 30.06, "unpaid"]);
      assert.equal((await refreshBill(bill)).status, "unpaid");
      bill.status = "paid";
      assert.equal((await refreshBill(bill)).status, "complete");
      // Cryptorefills.
      assert.ok((await listBrands("us")).some((b) => b.name === "Amazon"));
      const cr = await orderCryptorefills({ country: "US", brand: "Amazon", productId: "cr-amz-25", beneficiary: "friend@acme.test", email: "pat@acme.test", user: { ip: "203.0.113.9", userAgent: "t" } });
      assert.deepEqual([cr.invoice.issuedBy, cr.invoice.amountUsd], ["cryptorefills", 25.15]);
      // Credible: pairs, a saved bank account, a cash-out and an add-money order.
      assert.equal(bankingConfigured(), true);
      assert.deepEqual((await onrampPairs()).map((p) => p.chain), ["base"]);
      const acct = await addBankAccount({ firstName: "Asha", lastName: "Rao", accountNumber: "123456789012", ifsc: "HDFC0001234" });
      assert.equal(acct.last4, "9012");
      const out = await cashOut({ pairId: "demo-usdc-inr-base", amountUsdc: 50, bankAccountId: acct.id, firstName: "Asha", lastName: "Rao" });
      assert.deepEqual([out.invoice.issuedBy, out.bill?.provider, out.bill?.status], ["credible", "credible", "unpaid"]);
      const add = await startOnramp({ pairId: "demo-inr-usdc-base", amountInr: 5000, firstName: "Asha", lastName: "Rao", refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" });
      assert.ok(add.bank?.upiIntent.startsWith("upi://pay"));
      // Backpack: prices and a chart, funding as a payment, and a trade that uses what the simulated treasury paid in.
      const stocks = await listStocks();
      assert.ok(stocks.length >= 5 && stocks.every((s) => s.priceUsd && s.priceUsd > 0));
      assert.ok((await stockChart("AAPL.US", 30)).points.length >= 25);
      assert.equal((await account()).usdc, 0);
      const fund = await fundAccount({ amountUsd: 500 });
      assert.deepEqual([fund.invoice.issuedBy, fund.invoice.amountUsd], ["backpack", 500]);
      currentPolicy().investMaxUsd = 200;
      await assert.rejects(trade({ asset: "AAPL.US", side: "buy", amountUsd: 100 }), /Fund it first/);
      fund.status = "paid";
      assert.equal((await account()).usdc, 500);
      const done = await trade({ asset: "AAPL.US", side: "buy", amountUsd: 100 });
      assert.equal(done.status, "Filled");
      const held = await account();
      assert.ok(held.usdc < 410 && held.usdc > 395, `cash after the trade: ${held.usdc}`);
      assert.deepEqual(held.positions.map((p) => p.asset), ["AAPL.US"]);
    });
  } finally { globalThis.fetch = realFetch; }
  // None of it leaked into the live side of the same business.
  setMode(a.id, "live");
  assert.deepEqual(runAs(a.id, () => state().payments), []);
});

test("only an owner can switch, going live needs the treasury set up, and demo is always allowed", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const get = await modeGet(req(undefined, await as(a, "ada@acme.test"), "GET"), undefined);
  const g = (await get.json()) as { mode: string; missingForLive: { key: string }[] };
  assert.equal(g.mode, "live");
  assert.ok(g.missingForLive.some((m) => m.key === "TREASURY_ACCOUNT"), "a business with no treasury is told what live needs");

  const ada = await as(a, "ada@acme.test");
  const blocked = await modePost(req({ mode: "live" }, ada), undefined);
  assert.equal(blocked.status, 400);
  assert.match(((await blocked.json()) as { error: string }).error, /TREASURY_ACCOUNT/);

  assert.equal((await modePost(req({ mode: "demo" }, ada), undefined)).status, 200);
  assert.equal(modeOf(a.id), "demo");
  assert.equal((await modePost(req({ mode: "nonsense" }, ada), undefined)).status, 400);
  assert.equal((await modePost(req({ mode: "live" }), undefined)).status, 400, "not signed in");

  setTreasury(a.id, { custody: "manual", treasury: "acme.near" });
  assert.equal((await modePost(req({ mode: "live" }, ada), undefined)).status, 200);
  assert.equal(modeOf(a.id), "live");
});
