import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Cryptorefills read against the REAL service, nothing ordered: which USDC networks it takes, and (if it will talk to this network) its catalogue.
const T = { timeout: 90_000 };
for (const k of ["CRYPTOREFILLS_HOST", "CRYPTOREFILLS_PARTNER_HOST", "CRYPTOREFILLS_PARTNER_ID"]) delete process.env[k];

test("the real Cryptorefills takes USDC on chains NEAR Intents can pay, with Base among them", T, async () => {
  const { paymentNetworks } = await import("../../lib/cryptorefills");
  const nets = await paymentNetworks();
  assert.ok(nets.length >= 1, "at least one network");
  assert.ok(nets.every((n) => n.coin === "USDC" && ["base", "arb", "eth", "sol"].includes(n.chain)));
  assert.ok(nets.some((n) => n.chain === "base"), `Base is offered: ${nets.map((n) => n.network).join(", ")}`);
  assert.equal(nets[0].chain, "base", "Base is preferred when offered");
});

test("the real Cryptorefills catalogue lists brands and sizes (skipped if it refuses this network)", T, async (t) => {
  const { listBrands, listProducts, CryptorefillsError } = await import("../../lib/cryptorefills");
  try {
    const brands = await listBrands("US");
    assert.ok(brands.length > 5, `${brands.length} brands`);
    const b = brands.find((x) => /amazon/i.test(x.name)) ?? brands[0];
    const products = await listProducts("US", b.name);
    assert.ok(products.length >= 1 && products.every((p) => p.productId));
  } catch (e) {
    if (e instanceof CryptorefillsError && e.httpStatus === 403) return t.skip("Cryptorefills' catalogue answered 403 from this network: not worked around, so not verified here");
    throw e;
  }
});
