import { OPERATOR_WEBHOOK_SECRET, STRIPE_PORT } from "./setup-cards";
import assert from "node:assert/strict";
import { constants, createCipheriv, createHmac, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { configuredCardProvider, rainProvider, rampProvider, stripeProvider, type CardProvider } from "../lib/card-providers";
import { createBusiness, resetRegistry, setChannels } from "../lib/business";
import { runAs } from "../lib/tenant";
import { approveCardPurchase, cardSpentTodayUsd, closeCardPurchase, closeOpenCards, handleStripeWebhook, requestCardPurchase } from "../lib/cards";
import { makePolicy, DEFAULT_POLICY_BODY } from "../lib/policy";
import { services } from "../lib/services";
import { install, seed, state } from "./fakes";

// ---------- Local servers speaking each card issuer's API ----------

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: string }
let seen: Seen[] = [];
const servers: Server[] = [];
async function serve(handler: (r: Seen) => [number, unknown], port = 0): Promise<string> {
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(r);
      const [code, out] = handler(r);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

// Stripe: form-encoded, a card with a lifetime limit, its number only when expanded, cancel by status.
// Two Stripe accounts: the operator's and a signed-up business's. Each card remembers which account made it.
const STRIPE_KEYS = new Set(["sk_test_cards", "sk_test_bolt_0123456789"]);
const stripeCards: Record<string, { status: string; limit: number; account: string; cardholder: string }> = {};
let stripeBase = "";
// Ramp: a client-credentials token, then a vault card (fund + card in one), closed by deleting the fund.
const rampFunds = new Set<string>();
let rampBase = "";
// Rain: a card per user, its number encrypted under the session key we send (RSA-OAEP), closed by status.
const rainKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rainPublic = rainKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const rainCards: Record<string, { status: string; limit: number }> = {};
let rainBase = "";

function rainEncrypt(text: string, sessionId: string) {
  // What Rain does: recover our key from the session id with its private key, and encrypt the field under it.
  const keyB64 = privateDecrypt({ key: rainKeys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(sessionId, "base64")).toString("utf8");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-128-gcm", Buffer.from(keyB64, "base64"), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), data: data.toString("base64") };
}

before(async () => {
  stripeBase = await serve((r) => {
    const account = String(r.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!STRIPE_KEYS.has(account)) return [401, { error: { message: "Invalid API Key" } }];
    if (!r.headers["stripe-version"]) return [400, { error: { message: "no version" } }];
    const f = new URLSearchParams(r.body);
    if (r.method === "POST" && r.url === "/v1/issuing/cards") {
      const id = `ic_${Object.keys(stripeCards).length + 1}`;
      stripeCards[id] = { status: f.get("status")!, limit: Number(f.get("spending_controls[spending_limits][0][amount]")), account, cardholder: f.get("cardholder")! };
      return [200, { id, object: "issuing.card", last4: "4242", status: f.get("status"), exp_month: 8, exp_year: 2029 }];
    }
    const get = /^\/v1\/issuing\/cards\/(ic_\d+)\?expand\[\]=number&expand\[\]=cvc$/.exec(decodeURIComponent(r.url));
    if (r.method === "GET" && get) return [200, { id: get[1], last4: "4242", number: "4242424242424242", cvc: "123", exp_month: 8, exp_year: 2029 }];
    const upd = /^\/v1\/issuing\/cards\/(ic_\d+)$/.exec(r.url);
    if (r.method === "POST" && upd) { stripeCards[upd[1]].status = f.get("status")!; return [200, { id: upd[1], status: f.get("status") }]; }
    return [404, { error: { message: "not found" } }];
  }, STRIPE_PORT);
  rampBase = await serve((r) => {
    if (r.method === "POST" && r.url === "/developer/v1/token") {
      const ok = r.headers.authorization === `Basic ${Buffer.from("ramp_id:ramp_secret").toString("base64")}`;
      const f = new URLSearchParams(r.body);
      return ok && f.get("grant_type") === "client_credentials" ? [200, { access_token: "ramp_tok", expires_in: 3600, scope: f.get("scope") }] : [401, { error: "invalid_client" }];
    }
    if (r.headers.authorization !== "Bearer ramp_tok") return [401, { error: "unauthorized" }];
    if (r.method === "POST" && r.url === "/developer/v1/cards/vault") {
      const b = JSON.parse(r.body);
      const fund = `fund_${rampFunds.size + 1}`;
      rampFunds.add(fund);
      return [201, { card: { id: `rc_${rampFunds.size}`, pan: "5555444433331111", cvv: "987", expiration: "0930" }, spend_limit_id: fund, echo: b }];
    }
    const del = /^\/developer\/v1\/funds\/(fund_\d+)$/.exec(r.url);
    if (r.method === "DELETE" && del) { rampFunds.delete(del[1]); return [200, {}]; }
    return [404, {}];
  });
  rainBase = await serve((r) => {
    if (r.headers["api-key"] !== "rain_key") return [401, { message: "unauthorized" }];
    if (r.method === "POST" && r.url === "/issuing/users/user_1/cards") {
      const b = JSON.parse(r.body);
      const id = `rain_${Object.keys(rainCards).length + 1}`;
      rainCards[id] = { status: b.status, limit: b.limit.amount };
      return [200, { id, type: "virtual", status: b.status, last4: "0005", expirationMonth: "7", expirationYear: "2030", limit: b.limit }];
    }
    const sec = /^\/issuing\/cards\/(rain_\d+)\/secrets$/.exec(r.url);
    if (r.method === "GET" && sec) {
      const sid = String(r.headers.sessionid ?? "");
      if (!sid) return [400, { message: "SessionId required" }];
      return [200, { encryptedPan: rainEncrypt("4111 2222 3333 0005", sid), encryptedCvc: rainEncrypt("321", sid) }];
    }
    const upd = /^\/issuing\/cards\/(rain_\d+)$/.exec(r.url);
    if (r.method === "PATCH" && upd) { rainCards[upd[1]].status = JSON.parse(r.body).status; return [200, { id: upd[1], status: rainCards[upd[1]].status }]; }
    return [404, {}];
  });
});
after(() => { for (const s of servers) s.close(); });

const stripe = () => stripeProvider({ key: "sk_test_cards", cardholder: "ich_company", base: stripeBase });
const ramp = () => rampProvider({ clientId: "ramp_id", clientSecret: "ramp_secret", userId: "user_ramp", apiBase: rampBase, vaultBase: rampBase });
const rain = () => rainProvider({ apiKey: "rain_key", userId: "user_1", publicKeyPem: rainPublic, base: rainBase });

let provider: CardProvider = stripe();
beforeEach(() => {
  seen = [];
  install();
  seed();
  resetRegistry();
  provider = stripe();
  Object.assign(services, { cardProvider: () => provider });
});

const buy = (over: Record<string, unknown> = {}) => requestCardPurchase({ merchant: "Namecheap", merchantUrl: "https://www.namecheap.com", amountUsd: 42.5, reason: "Renew bluvfi.xyz for a year", ...over }, "maya");

// ---------- Each provider, end to end against its local server ----------

test("cards: Stripe Issuing makes a virtual card capped at the purchase for its whole life, returns the number once, and cancels it", async () => {
  const { purchase, card } = await buy();
  assert.equal(purchase.status, "issued");
  assert.deepEqual(card, { number: "4242424242424242", cvc: "123", expiry: "08/29" });
  const create = new URLSearchParams(seen[0].body);
  assert.equal(create.get("cardholder"), "ich_company");
  assert.equal(create.get("type"), "virtual");
  assert.equal(create.get("spending_controls[spending_limits][0][amount]"), "4250", "the cap is in cents, exactly the purchase");
  assert.equal(create.get("spending_controls[spending_limits][0][interval]"), "all_time");
  assert.equal(create.get("metadata[bluvfi_purchase]"), purchase.id);
  // Nothing secret is kept: only the last four digits.
  assert.equal(purchase.last4, "4242");
  assert.ok(!JSON.stringify(state()).includes("4242424242424242"), "the card number is not stored");
  await closeCardPurchase(purchase.id);
  assert.equal(stripeCards[purchase.cardId!].status, "canceled");
  assert.equal(purchase.status, "closed");
});

test("cards: Ramp's Vault API makes a fund and card together with a total limit; closing deletes the fund", async () => {
  provider = ramp();
  const { purchase, card } = await buy({ amountUsd: 99.99 });
  assert.equal(purchase.status, "issued");
  assert.deepEqual(card, { number: "5555444433331111", cvc: "987", expiry: "09/30" });
  const token = new URLSearchParams(seen[0].body);
  assert.equal(token.get("scope"), "cards:read_vault limits:write funds:write");
  const body = JSON.parse(seen[1].body);
  assert.deepEqual(body.spending_restrictions, { limit: { amount: 9999, currency_code: "USD" }, interval: "TOTAL" });
  assert.equal(body.user_id, "user_ramp");
  assert.equal(purchase.closeRef, "fund_1");
  await closeCardPurchase(purchase.id);
  assert.ok(!rampFunds.has("fund_1"), "the fund behind the card is terminated");
});

test("cards: Rain makes an all-time-limited card and its number comes back encrypted under a key only we hold", async () => {
  provider = rain();
  const { purchase, card } = await buy({ amountUsd: 12 });
  assert.equal(purchase.status, "issued");
  assert.deepEqual(card, { number: "4111222233330005", cvc: "321", expiry: "07/30" });
  assert.equal(rainCards[purchase.cardId!].limit, 1200);
  const secretsCall = seen.find((s) => s.url.endsWith("/secrets"))!;
  assert.ok(String(secretsCall.headers.sessionid).length > 100, "an RSA-encrypted session id is sent");
  await closeCardPurchase(purchase.id);
  assert.equal(rainCards[purchase.cardId!].status, "canceled");
});

// ---------- The policy decides before any card exists ----------

test("cards: the kill switch, a missing card budget, the daily budgets and the blocklist refuse, and no card is made", async () => {
  state().killSwitch = true;
  assert.equal((await buy()).purchase.status, "refused");
  state().killSwitch = false;

  state().policies.push(makePolicy(2, { ...DEFAULT_POLICY_BODY, cardDailyLimitUsd: 0 }));
  const none = await buy();
  assert.equal(none.purchase.status, "refused");
  assert.match(none.purchase.note, /no card budget/);
  state().policies.push(makePolicy(3, { ...DEFAULT_POLICY_BODY, cardDailyLimitUsd: 100 }));

  assert.equal((await buy({ amountUsd: 60 })).purchase.status, "issued");
  const over = await buy({ amountUsd: 60 });
  assert.equal(over.purchase.status, "refused", "60 + 60 is past the 100 card budget");
  assert.match(over.purchase.note, /card spending past/);
  assert.equal(cardSpentTodayUsd(), 60, "a refused purchase does not use the budget");

  state().blocklist.push({ id: "bl-1", kind: "domain", value: "namecheap.com", reason: "phishing lookalike", evidenceHash: "x", reportedBy: "maya", at: new Date().toISOString() });
  const blocked = await buy({ amountUsd: 5 });
  assert.equal(blocked.purchase.status, "refused");
  assert.match(blocked.purchase.note, /blocklist/);
  assert.equal(Object.keys(stripeCards).length >= 1, true);
  assert.equal(seen.filter((s) => s.method === "POST" && s.url === "/v1/issuing/cards").length, 1, "only the allowed purchase made a card");
});

test("cards: a merchant whose name is on the OFAC list is refused; a near match or an unscreened one waits for signers", async () => {
  services.screenSanctions = async () => ({ status: "hit", hits: [{ kind: "name", entity: "BAD CO", program: "SDN", matched: "Bad Co", exact: true, detail: "Same name as BAD CO (SDN)" }], note: "" });
  assert.equal((await buy({ merchant: "Bad Co" })).purchase.status, "refused");
  services.screenSanctions = async () => ({ status: "unavailable", hits: [], note: "list down" });
  const r = await buy();
  assert.equal(r.purchase.status, "awaiting_approval");
  assert.match(r.purchase.needsApprovalBecause!, /could not be screened/);
  assert.equal(r.card, undefined);
});

test("cards: from the approval threshold the card waits for two signers, and the approval that completes it gets the number", async () => {
  state().policies.push(makePolicy(2, { ...DEFAULT_POLICY_BODY, cardDailyLimitUsd: 20_000, approvalThresholdUsd: 1_000 }));
  const r = await buy({ amountUsd: 1_500, merchant: "Dell", merchantUrl: "https://www.dell.com" });
  assert.equal(r.purchase.status, "awaiting_approval");
  assert.equal(r.card, undefined);
  const one = await approveCardPurchase(r.purchase.id, "maya");
  assert.equal(one.purchase.status, "awaiting_approval");
  const again = await approveCardPurchase(r.purchase.id, "maya");
  assert.equal(again.card, undefined, "the same signer twice is still one approval");
  // While it waited, the kill switch went on: the policy is checked again when the last approval comes in.
  state().killSwitch = true;
  const stopped = await approveCardPurchase(r.purchase.id, "devon");
  assert.equal(stopped.purchase.status, "refused");
  state().killSwitch = false;

  const r2 = await buy({ amountUsd: 1_500, merchant: "Dell" });
  await approveCardPurchase(r2.purchase.id, "maya");
  const done = await approveCardPurchase(r2.purchase.id, "devon");
  assert.equal(done.purchase.status, "issued");
  assert.equal(done.card?.number, "4242424242424242");
});

test("cards: every business uses its own card-issuing account: none until it connects one, then only its own keys and cardholder", async () => {
  Object.assign(services, { cardProvider: configuredCardProvider });
  const bolt = createBusiness("Bolt Inc", "bob@bolt.test");
  const acme = createBusiness("Acme Ltd", "ada@acme.test");
  // Nothing falls back to the operator's account or another business's.
  await assert.rejects(runAs(bolt.id, async () => { seed(); return buy(); }), /no card provider set up/);

  setChannels(bolt.id, { cardProvider: "stripe", stripeKey: "sk_test_bolt_0123456789", stripeCardholder: "ich_bolt_company", stripeWebhookSecret: "whsec_bolt_0123456789" });
  assert.equal(JSON.stringify(bolt.channels).includes("sk_test_bolt_0123456789"), false, "the key is stored encrypted");
  const { purchase, card } = await runAs(bolt.id, async () => { seed(); return buy(); });
  assert.equal(purchase.status, "issued");
  assert.equal(card?.number, "4242424242424242");
  assert.deepEqual([stripeCards[purchase.cardId!].account, stripeCards[purchase.cardId!].cardholder], ["sk_test_bolt_0123456789", "ich_bolt_company"], "made on Bolt's own Stripe account, for Bolt's cardholder");
  await assert.rejects(runAs(acme.id, async () => { seed(); return buy(); }), /no card provider set up/, "Acme still has none");

  // Bolt's webhook (?b=<bolt>) accepts only Bolt's signing secret; the operator's secret, or Bolt's event sent to the operator's URL, is refused.
  const ev = authEvent(purchase.cardId!, 4000);
  const boltSig = (t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", "whsec_bolt_0123456789").update(`${t}.${ev}`).digest("hex")}`;
  assert.equal((await handleStripeWebhook(ev, signed(ev), bolt.id)).status, 400, "the operator's secret does not open Bolt's webhook");
  const atOperator = await handleStripeWebhook(ev, signed(ev));
  assert.equal(atOperator.decision, false, "the operator's business does not know Bolt's card");
  const ok = await handleStripeWebhook(ev, boltSig(), bolt.id);
  assert.deepEqual([ok.status, ok.decision], [200, true]);

  // The scheduled sweep closes each business's expired cards with that business's own keys.
  const { closeOpenCardsEverywhere } = await import("../lib/cards");
  const later = Date.now() + 25 * 3_600_000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    const swept = await closeOpenCardsEverywhere();
    assert.deepEqual(swept[bolt.id]?.closed, [purchase.id]);
  } finally {
    Date.now = realNow;
  }
  assert.equal(stripeCards[purchase.cardId!].status, "canceled");
});

test("cards: a business's card keys are checked when saved, and the Settings status never shows a secret", async () => {
  const { channelStatus } = await import("../lib/business");
  const b = createBusiness("Cobalt Co", "cy@cobalt.test");
  assert.throws(() => setChannels(b.id, { stripeKey: "pk_test_publishable0123" }), /Stripe secret key/);
  assert.throws(() => setChannels(b.id, { stripeCardholder: "cus_123456" }), /cardholder id starts with ich_/);
  assert.throws(() => setChannels(b.id, { cardProvider: "paypal" }), /stripe, ramp or rain/);
  assert.throws(() => setChannels(b.id, { rainPublicKey: "not a key" }), /PEM/);
  setChannels(b.id, { cardProvider: "ramp", rampClientId: "ramp_client_1", rampClientSecret: "ramp-secret-0123456789", rampUserId: "user_ramp_1", rampSandbox: "1" });
  const st = channelStatus(b.id, true).cards;
  assert.deepEqual([st.provider, st.ramp, st.rampSandbox, st.fromEnv], ["ramp", true, true, false]);
  assert.equal(JSON.stringify(st).includes("ramp-secret-0123456789"), false);
  setChannels(b.id, { rampClientId: "", rampClientSecret: "", rampUserId: "", rampSandbox: "" });
  assert.equal(channelStatus(b.id).cards.provider, "", "disconnected");
});

// ---------- Stripe's real-time authorizations, and closing cards ----------

const WH = OPERATOR_WEBHOOK_SECRET;
const signed = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", WH).update(`${t}.${body}`).digest("hex")}`;
const authEvent = (card: string, cents: number, merchant = "NAMECHEAP.COM", currency = "usd") =>
  JSON.stringify({ type: "issuing_authorization.request", data: { object: { id: `iauth_${cents}`, card: { id: card }, pending_request: { amount: cents, currency }, merchant_data: { name: merchant } } } });

test("cards: Stripe asks before each charge: the first one within the amount is approved, everything else declined", async () => {
  const { purchase } = await buy();
  const card = purchase.cardId!;
  const forged = await handleStripeWebhook(authEvent(card, 4000), "t=1,v1=00");
  assert.equal(forged.status, 400, "an unsigned request is refused");
  const old = authEvent(card, 4000);
  assert.equal((await handleStripeWebhook(old, signed(old, Math.floor(Date.now() / 1000) - 600))).status, 400, "a ten-minute-old signature is a replay");

  const tooMuch = authEvent(card, 5000);
  assert.equal((await handleStripeWebhook(tooMuch, signed(tooMuch))).decision, false, "$50 is over the $42.50 card");
  const euros = authEvent(card, 4000, "NAMECHEAP.COM", "eur");
  assert.equal((await handleStripeWebhook(euros, signed(euros))).decision, false);
  const ok = authEvent(card, 4250);
  const r = await handleStripeWebhook(ok, signed(ok));
  assert.deepEqual([r.status, r.decision, r.body.approved], [200, true, true]);
  assert.equal(purchase.status, "used");
  const second = authEvent(card, 100, "SOMEONE ELSE");
  assert.equal((await handleStripeWebhook(second, signed(second))).decision, false, "a one-time card is charged once");
  assert.deepEqual(purchase.authorizations.map((a) => a.approved), [false, true, false, false]);
  const unknown = authEvent("ic_not_ours", 100);
  assert.equal((await handleStripeWebhook(unknown, signed(unknown))).decision, false);
});

test("cards: with the kill switch on, charges are declined; turning it on closes every open card; unused cards close when their time is up", async () => {
  const a = await buy();
  const b = await buy({ amountUsd: 10 });
  state().killSwitch = true;
  const ev = authEvent(a.purchase.cardId!, 100);
  assert.equal((await handleStripeWebhook(ev, signed(ev))).decision, false);
  const all = await closeOpenCards({ all: true, why: "kill switch" });
  assert.deepEqual(all.closed.sort(), [a.purchase.id, b.purchase.id].sort());
  assert.equal(stripeCards[a.purchase.cardId!].status, "canceled");
  state().killSwitch = false;

  const c = await buy({ amountUsd: 5 });
  assert.deepEqual((await closeOpenCards()).closed, [], "a fresh card is left alone");
  const later = Date.now() + 25 * 3_600_000;
  assert.deepEqual((await closeOpenCards({ now: later })).closed, [c.purchase.id], "after 24 hours it is closed");
  assert.equal(stripeCards[c.purchase.cardId!].status, "canceled");
});
