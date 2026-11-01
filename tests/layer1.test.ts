import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { approve, cancel, processInvoice, setKillSwitch } from "../lib/agent";
import { approveProposal, propose, validateChanges } from "../lib/governance";
import { DEFAULT_POLICY_BODY, makePolicy, verifyPolicyHistory } from "../lib/policy";
import { currentPolicy } from "../lib/store";
import type { PolicyProposal } from "../lib/types";
import { install, invoice, seed, state } from "./fakes";

/** Layer 1 (policy set by humans, enforced without a contract): the rules that live in this app. */
beforeEach(() => {
  install();
  seed();
});

const body = (over: Partial<PolicyProposal["changes"]> = {}): PolicyProposal["changes"] => ({
  ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, ...over,
});

test("a held payment waits out its hold window: it can be cancelled, not approved, until the window ends", async () => {
  state().policies = [makePolicy(1, body({ holdWindowMinutes: 30 }))];
  const p = await processInvoice(invoice()); // first payment to an address is held
  assert.equal(p.status, "held");
  assert.ok(p.holdUntil && new Date(p.holdUntil) > new Date());
  await assert.rejects(() => approve(p.id, "maya"), /hold window/);
  p.holdUntil = new Date(Date.now() - 1000).toISOString(); // the window has ended
  assert.equal((await approve(p.id, "maya")).status, "ready_to_send");

  const q = await processInvoice(invoice({ invoiceNumber: "INV-2", poNumber: "PO-2", amountUsd: 900 }));
  assert.equal(q.status, "held");
  assert.equal(cancel(q.id).status, "cancelled"); // cancelling is always possible
});

test("policy changes need distinct signers: one signer approving twice does not apply them", () => {
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  assert.equal(p.status, "open");
  approveProposal(p.id, "maya");
  assert.equal(p.status, "open");
  assert.equal(currentPolicy().version, 1);
  approveProposal(p.id, "devon");
  assert.equal(p.status, "applied");
  assert.equal(currentPolicy().version, 2);
  assert.equal(currentPolicy().perPaymentLimitUsd, 2000);
  assert.throws(() => approveProposal(p.id, "mallory"), /Unknown signer/);
});

test("every policy version is hashed, the history re-verifies, and an edited version is caught", () => {
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 3000, dailyLimitUsd: 6000 }), "maya");
  approveProposal(p.id, "devon");
  assert.deepEqual(verifyPolicyHistory(state().policies), { ok: true, problems: [] });
  assert.notEqual(state().policies[0].hash, state().policies[1].hash);

  state().policies[1].perPaymentLimitUsd = 999_999; // quietly raised after the fact
  const bad = verifyPolicyHistory(state().policies);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /Version 2 does not match its hash/);

  state().policies[1].perPaymentLimitUsd = 3000;
  state().policies.push({ ...state().policies[1], version: 5 });
  assert.equal(verifyPolicyHistory(state().policies).ok, false); // a gap in the version numbers
});

test("a policy that could not work or would disable a rule is refused", () => {
  const refuse = (over: Partial<PolicyProposal["changes"]>, re: RegExp) => assert.throws(() => validateChanges(body(over)), re);
  refuse({ perPaymentLimitUsd: -1 }, /zero or more/);
  refuse({ perPaymentLimitUsd: Number.NaN }, /zero or more/);
  refuse({ perPaymentLimitUsd: 0 }, /stop every payment/);
  refuse({ perPaymentLimitUsd: 9000, dailyLimitUsd: 1000 }, /daily limit cannot be below/);
  refuse({ allowedChains: [] }, /at least one chain/);
  refuse({ allowedChains: ["near", "dogechain"] }, /Unknown chain "dogechain"/);
  refuse({ allowedAssets: ["USDC", "SHIB"] }, /Unknown asset "SHIB"/);
  assert.doesNotThrow(() => validateChanges(body()));
  assert.throws(() => propose(body({ allowedChains: ["nope"] }), "maya"), /Unknown chain/);
  assert.equal(state().proposals.length, 0); // nothing was recorded
});

test("limits, chains, assets and the allowlist are checked again at release, under the policy in force then", async () => {
  const p = await processInvoice(invoice({ invoiceNumber: "INV-9", poNumber: "PO-BIG", amountUsd: 7000 }));
  assert.ok(["awaiting_approval", "held"].includes(p.status));
  // The policy tightens after the payment was reviewed but before a signer approves it.
  state().policies.push(makePolicy(2, body({ perPaymentLimitUsd: 5000, dailyLimitUsd: 5000 })));
  const out = await approve(p.id, "maya");
  assert.equal(out.status, "blocked");
  assert.match(out.headline, /Blocked at release/);

  const c = await processInvoice(invoice({ invoiceNumber: "INV-10", poNumber: "PO-2", amountUsd: 900 }));
  state().policies.push(makePolicy(3, body({ allowedChains: ["eth"] })));
  assert.equal((await approve(c.id, "devon")).status, "blocked");
});

test("any signer can flip the kill switch, and who did it and when is recorded", async () => {
  setKillSwitch(true, "devon");
  assert.equal(state().killSwitch, true);
  assert.equal(state().killLog[0].by, "devon");
  assert.equal(state().killLog[0].on, true);
  const p = await processInvoice(invoice());
  assert.equal(p.status, "blocked");
  assert.match(p.headline, /kill switch/i);
  setKillSwitch(false, "maya");
  assert.deepEqual(state().killLog.map((e) => [e.by, e.on]), [["maya", false], ["devon", true]]);
});
