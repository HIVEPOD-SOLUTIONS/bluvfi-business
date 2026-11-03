import { outlayer } from "./setup-outlayer";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCustody, resetCustodyCache } from "../../lib/custody";

/**
 * OutLayer custody against OutLayer's real TESTNET API. OutLayer's dashboard only opens mainnet wallets, so a testnet wallet
 * can never be given a policy; the policy tests are in tests/real/outlayer.test.ts, against a read-only mainnet wallet.
 */
const T = { timeout: 120_000 };

const policy = async () => (await (await fetch(`${outlayer.baseUrl}/wallet/v1/policy`, { headers: { authorization: `Bearer ${outlayer.apiKey}` } })).json()) as { policy?: string; frozen?: boolean; rules?: { limits?: Record<string, unknown> } };

test("a real OutLayer wallet with no policy is unrestricted, so the custody check refuses it", T, async (t) => {
  if ((await policy()).policy === "stored") return t.skip("This wallet now has a policy, so the no-policy case cannot be shown on it.");
  resetCustodyCache();
  const c = await checkCustody();
  assert.equal(c.ok, false);
  assert.match(c.problems.join(" "), /no policy, so it is unrestricted/);
});
