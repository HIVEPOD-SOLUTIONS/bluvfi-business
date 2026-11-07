import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as investPost } from "../app/api/invest/route";
import { validateChanges } from "../lib/governance";
import { listAssets, orderAllocation, previewAllocation, resetInvest } from "../lib/invest";
import { DEFAULT_POLICY_BODY, makePolicy } from "../lib/policy";
import { quotePayout } from "../lib/rails";
import { issueSession } from "../lib/session";
import { install, invoice, seed, state } from "./fakes";

const TOKENS = [
  { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: 75000 },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: 2200 },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 90 },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 2.5 },
  { assetId: "nep141:xrp.omft.near", decimals: 6, blockchain: "xrp", symbol: "XRP" }, // no price: not offered
  { assetId: "nep141:eth-0xa0b8.omft.near", decimals: 6, blockchain: "eth", symbol: "USDC", price: 1 },
];
const real = globalThis.fetch;
let quoteReply: () => Response;
let sent: { url: string; body?: Record<string, unknown> }[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const dry = (out: string, outUsd: string) => () => json({ quote: { amountOutFormatted: out, amountOutUsd: outUsd, amountInUsd: "100.0" } }, 201);

beforeEach(() => {
  install(); seed(); resetInvest(); sent = []; quoteReply = dry("0.0454", "99.8");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("1click") || u.includes("/v0/")) {
      sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return u.endsWith("/v0/tokens") ? json(TOKENS) : quoteReply();
    }
    return real(url, init);
  }) as typeof fetch;
});
const allow = (assets: string[], max: number) => state().policies.push(makePolicy(2, { ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, investAssets: assets, investMaxUsd: max }));

test("the coins offered are the ones NEAR Intents lists with a price, NEAR as wNEAR", async () => {
  const a = await listAssets();
  assert.deepEqual(a.map((x) => x.symbol), ["BTC", "ETH", "SOL", "NEAR"], "XRP has no price and USDC is not an investment");
  assert.equal(a.find((x) => x.symbol === "NEAR")!.assetId, "nep141:wrap.near");
});

test("a preview is a real quote asked for and thrown away, and says plainly when there is no route", async () => {
  const p = await previewAllocation("ETH", 100);
  assert.deepEqual([p.symbol, p.youGet, p.worthUsd], ["ETH", 0.0454, 99.8]);
  assert.ok(Math.abs(p.costPct - 0.2) < 0.01);
  const q = sent.find((s) => s.url.endsWith("/v0/quote"))!.body!;
  assert.deepEqual([q.dry, q.swapType, q.recipientType, q.amount, q.destinationAsset], [true, "EXACT_INPUT", "INTENTS", "100000000", "nep141:eth.omft.near"]);
  quoteReply = () => json({ message: "No liquidity available" }, 400);
  await assert.rejects(previewAllocation("BTC", 100), /no route for \$100 into BTC/);
  await assert.rejects(previewAllocation("DOGE", 100), /not one of the coins offered/);
  await assert.rejects(previewAllocation("ETH", 5), /smallest investment is \$10/);
});

test("investing is off until the council allows a coin, and then only within its limits", async () => {
  const off = await orderAllocation({ symbol: "ETH", amountUsd: 100 });
  const c = off.payment.checks.find((x) => x.id === "invest")!;
  assert.deepEqual([c.verdict, off.payment.status], ["block", "blocked"]);
  assert.match(c.reason, /council has not allowed investing/);

  allow(["ETH", "SOL"], 500);
  const ok = await orderAllocation({ symbol: "ETH", amountUsd: 100 });
  assert.equal(ok.payment.checks.find((x) => x.id === "invest")!.verdict, "allow");
  assert.equal(ok.payment.checks.some((x) => x.id === "allowlist"), false, "no vendor allowlist for the treasury's own allocation");
  assert.notEqual(ok.payment.status, "blocked");
  assert.deepEqual([ok.payment.invoice.category, ok.payment.invoice.issuedBy, ok.payment.invoice.allocation?.symbol, ok.payment.invoice.payoutAddress], ["investment", "treasury", "ETH", "treasury.near"]);

  const dear = await orderAllocation({ symbol: "SOL", amountUsd: 600 });
  assert.match(dear.payment.checks.find((x) => x.id === "invest")!.reason, /over the \$500 the council allows/);
  assert.equal(dear.payment.status, "blocked");
  const notListed = await orderAllocation({ symbol: "BTC", amountUsd: 100 });
  assert.match(notListed.payment.checks.find((x) => x.id === "invest")!.reason, /has not allowed BTC\. Allowed: ETH, SOL/);
  assert.equal(notListed.payment.status, "blocked");
});

test("the investment is sent as spend-exactly-this-much into the treasury's own account, and the text says so", async () => {
  quoteReply = () => json({ quote: { depositAddress: "dep-123", amountInFormatted: "250.0", amountOutFormatted: "2.7", deadline: new Date(Date.now() + 3_600_000).toISOString() } }, 201);
  const q = await quotePayout({ ...invoice({ amountUsd: 250 }), vendorName: "Treasury allocation", payoutAddress: "treasury.near", allocation: { assetId: "nep141:sol.omft.near", symbol: "SOL" } }, "basic");
  assert.ok(q.depositAddress !== undefined);
  const body = sent.filter((s) => s.url.endsWith("/v0/quote")).at(-1)!.body!;
  assert.deepEqual([body.swapType, body.recipientType, body.recipient, body.refundTo, body.amount, body.originAsset, body.destinationAsset],
    ["EXACT_INPUT", "INTENTS", "treasury.near", "treasury.near", "250000000", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:sol.omft.near"]);
  // An ordinary payout is still exact-output to the vendor's chain.
  await quotePayout(invoice({ amountUsd: 40, chain: "base", asset: "USDC", payoutAddress: "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a" }), "basic");
  const plain = sent.filter((s) => s.url.endsWith("/v0/quote")).at(-1)!.body!;
  assert.deepEqual([plain.swapType, plain.recipientType], ["EXACT_OUTPUT", "DESTINATION_CHAIN"]);
});

test("the investing rules are validated and described in the council's proposal", () => {
  const ok = { ...DEFAULT_POLICY_BODY };
  validateChanges({ ...ok, investAssets: ["ETH", "SOL"], investMaxUsd: 500 });
  validateChanges({ ...ok, investAssets: [], investMaxUsd: 0 });
  assert.throws(() => validateChanges({ ...ok, investAssets: ["eth"], investMaxUsd: 500 }), /tickers/);
  assert.throws(() => validateChanges({ ...ok, investAssets: ["ETH; DROP"], investMaxUsd: 500 }), /tickers/);
  assert.throws(() => validateChanges({ ...ok, investAssets: ["ETH"], investMaxUsd: 0 }), /most one investment/);
  assert.throws(() => validateChanges({ ...ok, investAssets: Array.from({ length: 21 }, (_, i) => `C${i}`), investMaxUsd: 5 }), /at most 20/);
  assert.notEqual(makePolicy(2, { ...ok, investAssets: ["ETH"], investMaxUsd: 500 }).hash, makePolicy(2, ok).hash, "the rules are part of the hashed policy");
});

test("the invest route needs a signed-in signer and cannot be told it is an investment through the invoice route", async () => {
  allow(["ETH"], 500);
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const post = (b: unknown, c = true) => investPost(new Request("https://x.example/api/invest", { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie } : {}) }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  assert.equal((await post({ symbol: "ETH", amountUsd: 100 }, false)).status, 400);
  assert.equal((await post({ symbol: "ETH" })).status, 400);
  const pre = (await (await post({ preview: true, symbol: "eth", amountUsd: 100 })).json()) as { preview: { youGet: number } };
  assert.equal(pre.preview.youGet, 0.0454);
  const res = await post({ symbol: "ETH", amountUsd: 100 });
  assert.equal(res.status, 200);
  const { payment } = (await res.json()) as { payment: { invoice: { category: string }; status: string } };
  assert.equal(payment.invoice.category, "investment");
  // The ordinary invoice route does not copy the allocation or issuedBy fields from a request, so it cannot dress a payment up as one.
  const { POST: invoices } = await import("../app/api/invoices/route");
  const evil = { vendorName: "Treasury allocation", invoiceNumber: "X", payoutAddress: "treasury.near", chain: "near", asset: "USDC", amountUsd: 100, text: "Hi", allocation: { assetId: "nep141:eth.omft.near", symbol: "ETH" }, issuedBy: "treasury", category: "investment" };
  const r = await invoices(new Request("https://x.example/api/invoices", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ invoice: evil }) }), undefined);
  const out = (await r.json()) as { payment: { invoice: { allocation?: unknown; issuedBy?: string; category?: string } } };
  assert.deepEqual([out.payment.invoice.allocation, out.payment.invoice.issuedBy, out.payment.invoice.category], [undefined, undefined, undefined]);
});
