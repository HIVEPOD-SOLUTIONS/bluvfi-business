import { outlayer } from "./setup-outlayer";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCustody, resetCustodyCache } from "../../lib/custody";

/** OutLayer custody against OutLayer's real testnet API. Setting a wallet's policy is the OWNER's act in OutLayer's dashboard. */
const T = { timeout: 120_000 };

const policy = async () => (await (await fetch(`${outlayer.baseUrl}/wallet/v1/policy`, { headers: { authorization: `Bearer ${outlayer.apiKey}` } })).json()) as { policy?: string; frozen?: boolean; rules?: { limits?: Record<string, unknown> } };

test("a real OutLayer wallet with no policy is unrestricted, so the custody check refuses it", T, async (t) => {
  if ((await policy()).policy === "stored") return t.skip("This wallet now has a policy, so the no-policy case cannot be shown on it.");
  resetCustodyCache();
  const c = await checkCustody();
  assert.equal(c.ok, false);
  assert.match(c.problems.join(" "), /no policy, so it is unrestricted/);
});

test("with an owner-set policy, the app reports what OutLayer enforces and compares it with its own limits", T, async (t) => {
  const p = await policy();
  if (p.policy !== "stored") return t.skip(`Not run yet: this testnet wallet has no policy. Its owner sets one in OutLayer's dashboard: ${outlayer.handoffUrl}`);
  resetCustodyCache();
  const c = await checkCustody();
  const facts = c.facts.join("\n");
  assert.match(facts, /OutLayer wallet controlled by/);
  assert.match(facts + c.problems.join("\n"), /Limit sync: OutLayer allows|sets no per-payment limit for USDC/);
});
