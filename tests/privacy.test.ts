import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { processInvoice } from "../lib/agent";
import { daoPolicyTag, validateChanges } from "../lib/governance";
import { privacyFor, PRIVACY_PROFILES, type PrivacyProfile } from "../lib/privacy";
import { DEFAULT_POLICY_BODY, makePolicy } from "../lib/policy";
import type { PolicyProposal } from "../lib/types";
import { install, invoice, seed, state } from "./fakes";

const rules = (profile: PrivacyProfile, extra: Partial<PolicyProposal["changes"]> = {}) => ({ privacyFloor: PRIVACY_PROFILES[profile].floor, privacyTiers: PRIVACY_PROFILES[profile].tiers, ...extra });

test("an open treasury raises nothing unless a vendor is named", () => {
  assert.deepEqual(privacyFor("public", rules("open"), "Anyone", 1_000_000), { level: "public", why: [] });
  const named = privacyFor("public", rules("open", { privateVendors: { "Payroll Co": "advanced" } }), "Payroll Co", 10);
  assert.equal(named.level, "advanced");
  assert.match(named.why.join(), /Payroll Co is named as needing advanced privacy/);
});

test("a startup stays open for small public vendors, and goes private for large payments and named vendors", () => {
  const r = rules("startup", { privateVendors: { "Seed Investors LLC": "basic", "Law Firm": "advanced" } });
  assert.equal(privacyFor("public", r, "Hosting Co", 1_200).level, "public");
  assert.equal(privacyFor("public", r, "Hosting Co", 5_000).level, "basic");
  assert.equal(privacyFor("public", r, "Seed Investors LLC", 50).level, "basic");
  assert.equal(privacyFor("public", r, "Law Firm", 50).level, "advanced");
});

test("an institution is private by default and fully confidential from $25,000", () => {
  assert.equal(privacyFor("public", rules("institution"), "Anyone", 100).level, "basic");
  const big = privacyFor("public", rules("institution"), "Anyone", 25_000);
  assert.equal(big.level, "advanced");
  assert.match(big.why.join(), /\$25,000 or more are advanced/);
});

test("an investor or holder pays everything fully confidentially", () => {
  assert.equal(privacyFor("public", rules("holder"), "Anyone", 1).level, "advanced");
});

test("a payment is never lowered: asking for more than the rules is kept, and the highest rule wins", () => {
  assert.deepEqual(privacyFor("advanced", rules("open"), "Anyone", 1), { level: "advanced", why: [] });
  const r = rules("institution", { privateVendors: { Acme: "advanced" } });
  assert.equal(privacyFor("public", r, "Acme", 100).level, "advanced", "the named vendor beats the basic floor");
});

test("the rules are validated, so a typo cannot silently turn privacy off", () => {
  const ok = { ...DEFAULT_POLICY_BODY };
  validateChanges({ ...ok, privacyProfile: "startup", privacyTiers: [{ aboveUsd: 5000, level: "basic" }], privateVendors: { A: "advanced" } });
  assert.throws(() => validateChanges({ ...ok, privacyProfile: "whale" as never }), /privacy profile/);
  assert.throws(() => validateChanges({ ...ok, privacyTiers: [{ aboveUsd: 0, level: "basic" }] }), /privacy tier/);
  assert.throws(() => validateChanges({ ...ok, privacyTiers: [{ aboveUsd: 100, level: "secret" as never }] }), /privacy tier/);
  assert.throws(() => validateChanges({ ...ok, privateVendors: { A: "hidden" as never } }), /private vendor/);
  assert.throws(() => validateChanges({ ...ok, privateVendors: { "": "basic" } }), /private vendor/);
});

test("the rules are part of the council's approved policy: changing one changes the hash the DAO vote is bound to", () => {
  const a = { ...DEFAULT_POLICY_BODY, privacyTiers: [{ aboveUsd: 5000, level: "basic" as const }] };
  const b = { ...DEFAULT_POLICY_BODY, privacyTiers: [{ aboveUsd: 5000, level: "advanced" as const }] };
  assert.notEqual(makePolicy(2, a).hash, makePolicy(2, b).hash);
  assert.notEqual(daoPolicyTag(2, a, "maya.near"), daoPolicyTag(2, b, "maya.near"));
  assert.notEqual(makePolicy(2, { ...DEFAULT_POLICY_BODY, privateVendors: { X: "basic" } }).hash, makePolicy(2, DEFAULT_POLICY_BODY).hash);
});

beforeEach(() => { install(); seed(); });

test("the agent applies the rules to a real payment and records why", async () => {
  const s = state();
  s.policies.push(makePolicy(2, { ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, privacyProfile: "startup", privacyFloor: "public", privacyTiers: [{ aboveUsd: 1000, level: "basic" }] }));
  const big = await processInvoice(invoice({ invoiceNumber: "INV-BIG", amountUsd: 1240 }), "public");
  assert.equal(big.confidentiality, "basic");
  assert.match(big.checks.find((c) => c.id === "privacy")!.reason, /raised from public to basic by policy v2: payments of \$1,000 or more are basic/);

  const small = await processInvoice(invoice({ invoiceNumber: "INV-SMALL", poNumber: "PO-2", amountUsd: 900 }), "public");
  assert.equal(small.confidentiality, "public");
  assert.ok(!small.checks.some((c) => c.id === "privacy"));
});

test("a named vendor's payment is raised whatever the amount, and tightening the rules applies at release too", async () => {
  const s = state();
  s.policies.push(makePolicy(2, { ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, privateVendors: { "Northwind Cloud Ltd": "advanced" } }));
  const p = await processInvoice(invoice({ invoiceNumber: "INV-VENDOR", poNumber: "PO-2", amountUsd: 900 }), "public");
  assert.equal(p.confidentiality, "advanced");
  assert.match(p.checks.find((c) => c.id === "privacy")!.reason, /Northwind Cloud Ltd is named as needing advanced privacy/);
});
