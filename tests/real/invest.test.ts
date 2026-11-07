import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Investing against the REAL NEAR Intents and the real NEAR chain, with nothing sent: the coin list, a real dry quote (asked for and discarded),
// and the real balance view of intents.near that the Invest page reads. Nothing is bought here.
const T = { timeout: 120_000 };

test("the real coin list offers the coins a business can invest in, with prices", T, async () => {
  const { listAssets, resetInvest } = await import("../../lib/invest");
  resetInvest();
  const a = await listAssets();
  const symbols = a.map((x) => x.symbol);
  for (const s of ["ETH", "SOL", "NEAR"]) assert.ok(symbols.includes(s), `${s} is offered: ${symbols.join(", ")}`);
  const eth = a.find((x) => x.symbol === "ETH")!;
  assert.equal(eth.assetId, "nep141:eth.omft.near");
  assert.ok(eth.priceUsd > 100 && eth.priceUsd < 100_000 && eth.decimals === 18);
  assert.equal(a.find((x) => x.symbol === "NEAR")!.assetId, "nep141:wrap.near");
});

test("a real quote says what $200 buys, within a few percent of the price, into the treasury's own account", T, async () => {
  const { listAssets, previewAllocation } = await import("../../lib/invest");
  for (const symbol of ["ETH", "SOL"]) {
    const p = await previewAllocation(symbol, 200);
    const price = (await listAssets()).find((x) => x.symbol === symbol)!.priceUsd;
    assert.ok(p.youGet > 0);
    assert.ok(Math.abs(p.youGet * price - 200) / 200 < 0.08, `${symbol}: ${p.youGet} at ${price} is not ~$200`);
    assert.ok(p.worthUsd > 180 && p.worthUsd <= 205, `worth ${p.worthUsd}`);
    assert.ok(p.costPct >= 0 && p.costPct < 5, `cost ${p.costPct}%`);
  }
});

test("a coin with no route right now is reported as that, not as a failure of ours", T, async () => {
  const { previewAllocation } = await import("../../lib/invest");
  // BTC has had no route into a NEAR Intents balance at times: either answer is honest, a made-up one is not.
  try {
    const p = await previewAllocation("BTC", 200);
    assert.ok(p.youGet > 0 && p.worthUsd > 150);
  } catch (e) {
    assert.match((e as Error).message, /no route for \$200 into BTC/);
  }
});

test("the treasury's holdings are read off the real chain: a real account's NEAR Intents balances, valued", T, async () => {
  const { holdings } = await import("../../lib/invest");
  const h = await holdings("near"); // a real mainnet account that holds a token inside intents.near
  assert.ok(Array.isArray(h));
  for (const x of h) {
    assert.ok(x.tokenId && x.amount > 0, JSON.stringify(x));
    assert.ok(x.valueUsd === null || x.valueUsd >= 0);
  }
  assert.deepEqual(await holdings("nobody-has-this-account-zzz.near"), [], "an account with nothing holds nothing");
});
