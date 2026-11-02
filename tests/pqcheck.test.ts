import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { processInvoice } from "../lib/agent";
import { appPqKeys, signPolicyCheck, verifyPolicyCheck } from "../lib/pqcheck";
import { currentPolicy, pqSeeds } from "../lib/store";
import { makeJob } from "../lib/zk";
import { install, invoice, seed } from "./fakes";

beforeEach(() => {
  install();
  seed();
});

const ctx = { killSwitch: false, spentTodayUsd: 0 };
const otherSeeds = { mlDsa: "11".repeat(32), slhDsa: "22".repeat(48) };

test("pq policy check: signed with ML-DSA-65 and SLH-DSA, re-run and verified", () => {
  const job = makeJob("pay-pq-1", invoice({ amountUsd: 7_000 }), currentPolicy(), ctx);
  const a = signPolicyCheck("pay-pq-1", job, pqSeeds());
  assert.equal(a.valid, true);
  assert.equal(a.slhDsa.signature.length, 17_088 * 2, "SLH-DSA-SHA2-128f signature");
  const r = verifyPolicyCheck("pay-pq-1", job, a, appPqKeys(pqSeeds()));
  assert.equal(r.status, "verified", r.note);
  assert.match(r.note, /passes/);
});

test("pq policy check: refused for another payment, a changed statement, a changed result or a foreign key", () => {
  const keys = appPqKeys(pqSeeds());
  const job = makeJob("pay-pq-2", invoice({ amountUsd: 900 }), currentPolicy(), ctx);
  const a = signPolicyCheck("pay-pq-2", job, pqSeeds());

  assert.match(verifyPolicyCheck("pay-pq-3", job, a, keys).note, /Signature check failed/, "same proof shown for another payment");
  assert.match(verifyPolicyCheck("pay-pq-2", { ...job, amount_cents: job.amount_cents + 1 }, a, keys).note, /not this payment's statement/);
  assert.match(verifyPolicyCheck("pay-pq-2", job, { ...a, outputBits: a.outputBits ^ 1 }, keys).note, /Re-running the check gives/);

  const forged = signPolicyCheck("pay-pq-2", job, otherSeeds);
  assert.match(verifyPolicyCheck("pay-pq-2", job, forged, keys).note, /not this app's/);
  // Keys right, one signature swapped for a forged one: both must hold.
  const mixed = { ...a, slhDsa: { ...a.slhDsa, signature: forged.slhDsa.signature } };
  assert.match(verifyPolicyCheck("pay-pq-2", job, mixed, keys).note, /ML-DSA-65 valid, SLH-DSA INVALID/);
});

test("pq policy check: every payment carries one at intake", async () => {
  const p = await processInvoice(invoice({ invoiceNumber: "INV-PQC" }));
  assert.ok(p.verified.policyCheckPq?.valid);
  assert.equal(verifyPolicyCheck(p.id, p.zkJob!, p.verified.policyCheckPq!, appPqKeys(pqSeeds())).status, "verified");
});
