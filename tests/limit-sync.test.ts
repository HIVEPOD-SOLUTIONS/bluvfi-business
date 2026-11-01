import "./setup";
import "./setup-outlayer";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { NEAR_USDC_CONTRACT } from "../lib/chains";
import { checkCustody, resetCustodyCache } from "../lib/custody";
import { install, seed } from "./fakes";

/** With OutLayer custody the app's limits are compared with the limits OutLayer enforces in its TEE. */
beforeEach(() => {
  install();
  seed(); // app policy: $10,000 per payment
  resetCustodyCache();
});

async function withPolicy(limits: unknown, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ wallet_id: "w1", controller: "acme.near", frozen: false, policy: "stored", rules: { limits }, approval: { threshold: { required: 2 } } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}
const sync = async () => (await checkCustody()).facts.find((f) => /per payment|per-payment/.test(f)) ?? "";

test("a custodian limit at or under the app's limit is reported as enforcing it too", async () => {
  await withPolicy({ per_transaction: { "*": "5000000000" } }, async () => assert.match(await sync(), /allows \$5,000 per payment, within the app's \$10,000/));
});

test("a token-specific limit wins over the wildcard", async () => {
  await withPolicy({ per_transaction: { "*": "999000000000", [NEAR_USDC_CONTRACT]: "2000000000" } }, async () => assert.match(await sync(), /allows \$2,000 per payment/));
});

test("a custodian limit above the app's is flagged so the owner can lower it", async () => {
  await withPolicy({ per_transaction: { "*": "50000000000" } }, async () => assert.match(await sync(), /allows \$50,000 per payment, above the app's \$10,000/));
});

test("no custodian limit means the app's limit is enforced by the app only, and that is said", async () => {
  await withPolicy({ daily: { "*": "10000000000" } }, async () => assert.match(await sync(), /sets no per-payment limit for USDC.*this app only/));
});
