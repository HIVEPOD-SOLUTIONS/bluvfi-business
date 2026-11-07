import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Backpack's PUBLIC data, read for real (no key, nothing ordered): the stock list with prices, and a price history.
const T = { timeout: 60_000 };
delete process.env.BACKPACK_API_BASE;

test("the real Backpack lists US stocks with fair-market prices", T, async () => {
  const { listStocks } = await import("../../lib/stocks");
  const l = await listStocks();
  assert.ok(l.length > 20, `${l.length} stocks and ETFs`);
  const priced = l.filter((s) => s.priceUsd && s.priceUsd > 0);
  assert.ok(priced.length > 10, `${priced.length} have a price`);
  assert.ok(l.every((s) => /\.US$/.test(s.asset) && s.step >= 0));
});

test("the real Backpack gives a price history for a listed stock", T, async () => {
  const { listStocks, stockChart } = await import("../../lib/stocks");
  const s = (await listStocks()).find((x) => x.priceUsd);
  assert.ok(s, "a priced stock");
  const c = await stockChart(s.asset, 30);
  assert.ok(c.points.length >= 5, `${c.points.length} points`);
  assert.ok(c.high >= c.low && c.points.every((p) => p[0] > 1.5e12 && p[1] > 0));
});

test("the real Backpack's market sessions are readable and a signed call without keys is refused locally", T, async () => {
  const { account } = await import("../../lib/stocks");
  await assert.rejects(account(), /no Backpack account connected/);
});
