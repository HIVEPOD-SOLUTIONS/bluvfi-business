import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { approve, cancel, processInvoice, setKillSwitch } from "../../lib/agent";
import { approveProposal, propose, validateChanges } from "../../lib/governance";
import { DEFAULT_POLICY_BODY, makePolicy, verifyPolicyHistory } from "../../lib/policy";
import { currentPolicy, resetState, state } from "../../lib/store";
import type { Invoice, PolicyProposal } from "../../lib/types";

/**
 * Layer 1 gate rules, end to end through the real pipeline with nothing faked (see ./setup.ts): the AI review really is
 * unavailable, so payments are held for a human; approving one really asks 1Click for a dry-run quote.
 */
const T = { timeout: 120_000 };
// A real, long-used EVM address (vitalik.eth). A brand-new unused address is correctly blocked as a risky receiver.
const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const body = (over: Partial<PolicyProposal["changes"]> = {}): PolicyProposal["changes"] => ({
  ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, allowedChains: ["eth", "near"], ...over,
});

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "inv", vendorName: "Northwind Cloud Ltd", vendorDomain: "northwind.io",
  vendorContact: { channel: "email", handle: "ap@northwind.io" },
  invoiceNumber: "INV-1", poNumber: "PO-1", amountUsd: 25, asset: "USDC", chain: "eth",
  payoutAddress: ADDRESS, text: "Managed hosting for November.", receivedAt: new Date().toISOString(), ...over,
});

beforeEach(() => {
  const s = resetState();
  s.vendors.push({
    name: "Northwind Cloud Ltd", domain: "northwind.io", verifiedContact: { channel: "email", handle: "ap@northwind.io" },
    payout: { chain: "eth", asset: "USDC", address: ADDRESS }, paidInvoiceNumbers: [],
  });
  s.purchaseOrders.push({ po: "PO-1", vendorName: "Northwind Cloud Ltd", amountUsd: 25 }, { po: "PO-2", vendorName: "Northwind Cloud Ltd", amountUsd: 40 }, { po: "PO-BIG", vendorName: "Northwind Cloud Ltd", amountUsd: 7000 });
  s.policies = [makePolicy(1, body())];
});

test("the AI review really cannot run without a key, so the payment is held for a human, never paid", T, async () => {
  const p = await processInvoice(invoice());
  assert.equal(p.status, "held");
  assert.equal(p.verified.signature.valid, false);
  assert.match(p.ai.summary, /unavailable/i);
});

test("a held payment waits out its hold window: it can be cancelled, not approved, until the window ends; then 1Click quotes it for real", T, async () => {
  state().policies = [makePolicy(1, body({ holdWindowMinutes: 30 }))];
  // "public": 1Click only quotes confidential (basic/advanced) payments for an authenticated partner (ONECLICK_JWT).
  const p = await processInvoice(invoice(), "public");
  assert.equal(p.status, "held");
  assert.ok(p.holdUntil && new Date(p.holdUntil) > new Date());
  await assert.rejects(() => approve(p.id, "maya"), /hold window/);

  p.holdUntil = new Date(Date.now() - 1000).toISOString(); // the window has ended
  const out = await approve(p.id, "maya");
  assert.equal(out.status, "approved", out.reason);
  assert.equal(out.quote?.source, "1click-dry"); // a real 1Click price, no deposit address
  assert.equal(out.approvedBy, "maya");

  const q = await processInvoice(invoice({ invoiceNumber: "INV-2", poNumber: "PO-2", amountUsd: 40 }));
  assert.equal(q.status, "held");
  assert.equal(cancel(q.id).status, "cancelled"); // cancelling is always possible
});

test("limits, chains and the allowlist are checked again at release, under the policy in force then", T, async () => {
  const p = await processInvoice(invoice({ invoiceNumber: "INV-9", poNumber: "PO-BIG", amountUsd: 7000 }));
  assert.ok(["awaiting_approval", "held"].includes(p.status));
  state().policies.push(makePolicy(2, body({ perPaymentLimitUsd: 5000, dailyLimitUsd: 5000 }))); // tightened after the review
  const out = await approve(p.id, "maya");
  assert.equal(out.status, "blocked");
  assert.match(out.headline, /Blocked at release/);

  const c = await processInvoice(invoice({ invoiceNumber: "INV-10", poNumber: "PO-2", amountUsd: 40 }));
  state().policies.push(makePolicy(3, body({ allowedChains: ["near"] })));
  assert.equal((await approve(c.id, "devon")).status, "blocked");
});

test("any signer can flip the kill switch, who did it and when is recorded, and payments stop", T, async () => {
  setKillSwitch(true, "devon");
  assert.equal(state().killSwitch, true);
  assert.equal(state().killLog[0].by, "devon");
  const p = await processInvoice(invoice());
  assert.equal(p.status, "blocked");
  assert.match(p.headline, /kill switch/i);
  setKillSwitch(false, "maya");
  assert.deepEqual(state().killLog.map((e) => [e.by, e.on]), [["maya", false], ["devon", true]]);
});

test("policy changes need distinct signers: one signer approving twice does not apply them", () => {
  const p = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  assert.equal(p.status, "open");
  approveProposal(p.id, "maya");
  assert.equal(p.status, "open");
  assert.equal(currentPolicy().version, 1);
  approveProposal(p.id, "devon");
  assert.equal(p.status, "applied");
  assert.equal(currentPolicy().version, 2);
  assert.throws(() => approveProposal(p.id, "mallory"), /Unknown signer/);
});

test("every policy version is hashed, the history re-verifies, and an edited version is caught", () => {
  const p = propose(body({ perPaymentLimitUsd: 3000, dailyLimitUsd: 6000 }), "maya");
  approveProposal(p.id, "devon");
  assert.deepEqual(verifyPolicyHistory(state().policies), { ok: true, problems: [] });
  state().policies[1].perPaymentLimitUsd = 999_999; // quietly raised after the fact
  assert.match(verifyPolicyHistory(state().policies).problems.join(), /Version 2 does not match its hash/);
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
  assert.equal(state().proposals.length, 0);
});
