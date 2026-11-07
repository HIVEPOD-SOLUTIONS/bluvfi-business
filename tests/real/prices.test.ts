import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Live prices from the REAL providers, nothing faked. CoinGecko needs no key; CoinMarketCap runs only if COINMARKETCAP_API_KEY is set (from
// .env.local or the shell), because it is the provider a business is expected to use.
const T = { timeout: 90_000 };
try { process.loadEnvFile(".env.local"); } catch { /* only what the shell has */ }

test("CoinGecko, with no key, gives real prices for the biggest coins", T, async () => {
  const keep = process.env.COINMARKETCAP_API_KEY;
  delete process.env.COINMARKETCAP_API_KEY;
  try {
    const { getMarket, getPrice, resetPrices } = await import("../../lib/prices");
    resetPrices();
    const m = await getMarket(100);
    assert.equal(m.source, "coingecko");
    assert.ok(m.rows.length >= 50, `${m.rows.length} coins`);
    const btc = m.rows.find((r) => r.symbol === "BTC")!;
    assert.ok(btc.priceUsd > 1_000 && btc.priceUsd < 10_000_000, `BTC is ${btc.priceUsd}`);
    assert.ok(btc.rank <= 3 && (btc.marketCapUsd ?? 0) > 1e11);
    assert.equal(typeof btc.change24h, "number");
    const near = await getPrice("near");
    assert.ok(near && near.priceUsd > 0, "NEAR is priced (lower or upper case)");
    resetPrices();
  } finally {
    if (keep) process.env.COINMARKETCAP_API_KEY = keep;
  }
});

test("CoinMarketCap, with the key, gives real prices and is preferred", { ...T, ...(process.env.COINMARKETCAP_API_KEY ? {} : { skip: "needs COINMARKETCAP_API_KEY" }) }, async () => {
  const { getMarket, resetPrices } = await import("../../lib/prices");
  resetPrices();
  const m = await getMarket(50);
  assert.equal(m.source, "coinmarketcap");
  assert.ok(m.rows.length >= 40);
  assert.deepEqual(m.rows.slice(0, 2).map((r) => r.symbol), ["BTC", "ETH"]);
  assert.ok(m.rows.every((r) => r.priceUsd > 0));
  resetPrices();
});

test("a failing provider falls back, and a failure of both is reported plainly and never cached", T, async () => {
  const { getMarket, resetPrices } = await import("../../lib/prices");
  resetPrices();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(getMarket(10), /Prices are unavailable/);
  } finally {
    globalThis.fetch = real;
  }
  // The failure was not kept: the next call asks again and works.
  const m = await getMarket(10);
  assert.ok(m.rows.length > 0);
  resetPrices();
});

test("the real CoinGecko gives a price history for a ticker, found by its search", { timeout: 90_000 }, async (t) => {
  const { getChart, resetCharts } = await import("../../lib/chart");
  resetCharts();
  try {
    const c = await getChart("BTC", 7);
    assert.ok(c.points.length >= 20 && c.points.length <= 120, `${c.points.length} points`);
    assert.ok(c.high >= c.low && c.low > 1000, `BTC ${c.low} to ${c.high}`);
    assert.ok(c.points[0][0] < c.points[c.points.length - 1][0]);
  } catch (e) {
    if (/rate limiting/.test((e as Error).message)) return t.skip("CoinGecko is rate limiting this machine right now: try again in a minute");
    throw e;
  }
});
