import { outlayer } from "./setup-outlayer";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCustody, resetCustodyCache } from "../../lib/custody";
import { currentPolicy } from "../../lib/store";

/** OutLayer custody against OutLayer's real API (read-only). Setting a wallet's policy is the OWNER's act in OutLayer's dashboard. */
const T = { timeout: 120_000 };

const policy = async () => (await (await fetch(`${outlayer.baseUrl}/wallet/v1/policy`, { headers: { authorization: `Bearer ${outlayer.apiKey}` } })).json()) as { policy?: string; frozen?: boolean; controller?: string; rules?: { limits?: { per_transaction?: Record<string, string>; daily?: Record<string, string> } } };

test("a real OutLayer wallet with no policy is unrestricted, so the custody check refuses it", T, async (t) => {
  if ((await policy()).policy === "stored") return t.skip("This wallet now has a policy, so the no-policy case cannot be shown on it.");
  resetCustodyCache();
  const c = await checkCustody();
  assert.equal(c.ok, false);
  assert.match(c.problems.join(" "), /no policy, so it is unrestricted/);
});

test("with the owner's policy, the app reports what OutLayer enforces and compares it with its own limits", T, async (t) => {
  const p = await policy();
  if (p.policy !== "stored") return t.skip(`Not run yet: this wallet has no policy. Its owner sets one in OutLayer's dashboard: ${outlayer.handoffUrl}`);
  resetCustodyCache();
  const c = await checkCustody();
  const facts = c.facts.join("\n");
  assert.match(facts, /OutLayer wallet controlled by/);
  // The app must say, per limit, whether OutLayer backs its own limit, from what OutLayer really returns.
  const perTx = p.rules?.limits?.per_transaction?.["*"] ?? Object.values(p.rules?.limits?.per_transaction ?? {})[0];
  if (perTx === undefined) assert.match(facts + c.problems.join("\n"), /sets no per-payment limit for USDC/);
  else assert.match(facts + c.problems.join("\n"), /Limit sync: OutLayer allows \$[\d,.]+ per payment, (within|above) the app's \$[\d,]+/);
  assert.ok(currentPolicy().perPaymentLimitUsd > 0);
});
