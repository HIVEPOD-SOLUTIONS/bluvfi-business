import "./setup-demo";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { demoDao } from "../lib/custody";
import { FIXTURE_DIR } from "../lib/demo";
import { runDemo } from "../lib/demo-scenario";
import { verifyNearAiBundle, type NearAiBundle } from "../lib/nearai";
import { verifyDecision } from "../lib/nearai-core";
import { state } from "../lib/store";

test("demo: the whole story runs with no keys, and every signature verifies", async () => {
  const r = await runDemo({ vendorReplies: true });
  assert.equal(r.history.status, "paid");
  assert.equal(r.normal.status, "paid");
  assert.equal(r.fraud.status, "cancelled");
  assert.equal(r.lookalike.status, "blocked");
  assert.equal(r.check.verdict, "block");
  for (const p of [r.history, r.normal, r.fraud, r.lookalike]) {
    assert.ok(p.verified.signature.valid, `${p.invoice.invoiceNumber} signature`);
    assert.ok(p.verified.pqSignature.valid, `${p.invoice.invoiceNumber} ML-DSA`);
    assert.equal(p.verified.attestation.source, "demo-fixture");
    assert.equal(p.verified.attestation.cpu, false, "hardware attestation is never claimed for demo fixtures");
  }
  assert.ok(r.fraud.checks.some((c) => c.id === "payout_changed" && c.verdict === "block"));
  assert.ok(r.fraud.checks.some((c) => c.id === "injection" && c.verdict === "block"));
  assert.ok(state().blocklist.some((b) => b.value === "acme-logistics-payments.near"));
});

test("demo: the payout went through the simulated DAO, with the evidence hash in the proposal", async () => {
  const r = await runDemo({ vendorReplies: true });
  const c = r.normal.custody!;
  assert.equal(c.backend, "sputnik");
  assert.equal(c.state, "executed");
  const prop = demoDao().get(Number(c.ref));
  assert.equal(prop.status, "Approved");
  assert.ok(prop.description.includes(`* Evidence: ${c.evidenceHash}`));
  assert.ok(prop.description.startsWith("* Proposal Action: payment-transfer <br>* Title: Invoice NW-1042"));
  assert.ok(prop.description.includes("* Recipient: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
  assert.ok(prop.description.includes("* Destination Network: nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"));
  assert.ok(prop.description.includes(r.normal.verified.signature.signature));
  assert.deepEqual(Object.keys(prop.votes).sort(), ["devon", "maya"]);
});

test("demo: a tampered fixture fails verification", async () => {
  const files = readdirSync(FIXTURE_DIR).map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as NearAiBundle);
  const bundle = files.find((b) => b.rawResponse.includes("Same vendor, same payout address"))!;
  const check = async (b: NearAiBundle) => {
    const j = await verifyNearAiBundle(b);
    return verifyDecision({ decision: j.decision, requestBody: j.requestBody, expectedNonce: j.expectedNonce }, { version: 1, hash: "x" }).signature.valid;
  };
  assert.equal(await check(bundle), true);
  // Flip the model's "pay" to "block" after signing: the response hash no longer matches what was signed.
  assert.equal(await check({ ...bundle, rawResponse: bundle.rawResponse.replace('\\"decision\\":\\"pay\\"', '\\"decision\\":\\"block\\"') }), false);
});
