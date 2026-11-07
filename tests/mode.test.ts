import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { GET as modeGet, POST as modePost } from "../app/api/mode/route";
import { orderBill } from "../lib/bills";
import { cfg, createBusiness, resetRegistry, setTreasury, type Business } from "../lib/business";
import { fundAccount } from "../lib/stocks";
import { COOKIE, issueSession, privySubject } from "../lib/session";
import { services } from "../lib/services";
import { resetAllState, state } from "../lib/store";
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

test("a business in demo cannot order a real bill, open a bank or fund a brokerage account", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  setMode(a.id, "demo");
  await runAs(a.id, async () => {
    await assert.rejects(orderBill({ productId: "x", packageValue: "10", email: "a@b.test" }), /demo mode, so it cannot order bills/);
    await assert.rejects(fundAccount({ amountUsd: 100 }), /cannot fund a brokerage account/);
  });
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
