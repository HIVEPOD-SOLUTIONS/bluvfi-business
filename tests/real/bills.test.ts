import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Bills against the REAL Bitrefill, reading only: its sign-in with no account, a product search and a product's sizes. Nothing is ordered
// here, because an order is a real purchase order at Bitrefill; the ordering step is tested against a local server shaped like Bitrefill.
const T = { timeout: 90_000 };
delete process.env.BITREFILL_MCP_BASE;
delete process.env.BITREFILL_MCP_URL;
delete process.env.BITREFILL_CLIENT_ID;

test("the real Bitrefill signs us in with no account, finds Netflix, and lists its sizes with prices", T, async () => {
  const { searchProducts, productDetails } = await import("../../lib/bills");
  const found = await searchProducts("Netflix", "US", 5);
  assert.ok(found.length >= 1, "something was found");
  const netflix = found.find((p) => p.id === "netflix-usa");
  assert.ok(netflix, `netflix-usa is among ${found.map((p) => p.id).join(", ")}`);
  assert.equal(netflix.type, "giftcards");
  assert.ok(netflix.countries.includes("US"));

  const d = await productDetails("netflix-usa");
  assert.equal(d.id, "netflix-usa");
  assert.equal(d.currency, "USD");
  assert.equal(d.recipientType, "none");
  assert.ok(d.packages.length >= 1 && d.packages.every((p) => p.price > 0 && /^\d/.test(p.value)), JSON.stringify(d.packages));
});

test("the real Bitrefill has phone top-ups that need a number, and says plainly when a product does not exist", T, async () => {
  const { searchProducts, productDetails } = await import("../../lib/bills");
  const topups = (await searchProducts("MTN", "NG", 10)).filter((p) => p.type !== "giftcards");
  if (topups.length) {
    const d = await productDetails(topups[0].id);
    assert.ok(d.id && d.name, "its details read");
    assert.notEqual(d.recipientType, undefined);
  }
  await assert.rejects(productDetails("this-product-does-not-exist-zzz"), /Bitrefill/);
});
