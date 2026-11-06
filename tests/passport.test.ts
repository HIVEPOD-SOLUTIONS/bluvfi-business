import "./setup";
import "./setup-passport";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { processInvoice } from "../lib/agent";
import { handleSelfWebhook, resetPassportIndex, selfApi, startPassport } from "../lib/passport";
import { makePolicy } from "../lib/policy";
import { currentPolicy } from "../lib/store";
import type { PolicyProposal } from "../lib/types";
import { install, invoice, seed, state } from "./fakes";

/** Self's three calls, faked: sessions it created, whether the signature is good, and whether a proof re-verifies. */
let sessions: string[] = [];
let signatureOk = true;
let proofOk = true;
let event: Record<string, unknown> = {};
selfApi.createSession = async (ref) => { sessions.push(ref); return { verificationUrl: `https://verify.self.xyz/s/verify_live_${ref.slice(0, 8)}` }; };
selfApi.verifyWebhook = async () => { if (!signatureOk) throw new Error("bad signature"); return event as never; };
selfApi.verifyProof = async () => proofOk;

beforeEach(() => {
  install();
  seed();
  resetPassportIndex();
  sessions = [];
  signatureOk = true;
  proofOk = true;
});

const completed = (ref: string, over: Record<string, unknown> = {}) => ({
  type: "verification.completed", verification_id: "ver_1", external_uuid: ref, flow_id: "f", flow_version_id: "fv", environment: "live", status: "valid",
  proof_attributes: { minimumAge: 18, ofac: true, name: "SHOULD NOT BE KEPT", documentNumber: "X123" },
  proof: { pi_a: ["1"] }, nullifier: "nullifier-1", verified_at: "2026-11-06T10:00:00.000Z", storage_state: "skipped", storage_uri: null, ...over,
});
const deliver = async (e: Record<string, unknown>) => { event = e; return handleSelfWebhook("{}", { "svix-id": "1", "svix-timestamp": "1", "svix-signature": "v1,x" }); };
const vendor = () => state().vendors[0];

test("passport: a vendor gets a hosted Self link; a valid, re-verified proof verifies them and keeps only the checks, never personal data", async () => {
  const { link, passport } = await startPassport("vendor", "Northwind Cloud Ltd");
  assert.match(link, /^https:\/\/verify\.self\.xyz\/s\//);
  assert.equal(passport.status, "pending");
  assert.equal(sessions[0], passport.sessionRef);

  const r = await deliver(completed(passport.sessionRef));
  assert.ok(r.ok, r.detail);
  const p = vendor().passport!;
  assert.equal(p.status, "verified");
  assert.equal(p.nullifier, "nullifier-1");
  assert.deepEqual(p.checks, { minimumAge: 18, ofac: true }, "only the predicates are kept: no name, no document number");
});

test("passport: a bad signature, a proof that does not re-verify, or a test-environment proof never verifies anyone", async () => {
  const { passport } = await startPassport("vendor", "Northwind Cloud Ltd");
  signatureOk = false;
  assert.deepEqual(await deliver(completed(passport.sessionRef)), { ok: false, detail: "Bad signature" });
  assert.equal(vendor().passport!.status, "pending");

  signatureOk = true;
  proofOk = false;
  await deliver(completed(passport.sessionRef));
  assert.equal(vendor().passport!.status, "declined");
  assert.match(vendor().passport!.note!, /did not re-verify/);

  const again = await startPassport("vendor", "Northwind Cloud Ltd");
  proofOk = true;
  await deliver(completed(again.passport.sessionRef, { environment: "test" }));
  assert.equal(vendor().passport!.status, "declined");
  assert.match(vendor().passport!.note!, /SELF_ALLOW_TEST/);
});

test("passport: one passport verifies one party, and an old session cannot overwrite a newer check", async () => {
  state().vendors.push({ ...vendor(), name: "Second Vendor Ltd", passport: undefined, kyb: undefined });
  const a = await startPassport("vendor", "Northwind Cloud Ltd");
  await deliver(completed(a.passport.sessionRef));
  const b = await startPassport("vendor", "Second Vendor Ltd");
  await deliver(completed(b.passport.sessionRef)); // the same nullifier
  const second = state().vendors.find((v) => v.name === "Second Vendor Ltd")!.passport!;
  assert.equal(second.status, "declined");
  assert.match(second.note!, /already verified vendor Northwind Cloud Ltd/);

  const old = await startPassport("vendor", "Second Vendor Ltd");
  await startPassport("vendor", "Second Vendor Ltd"); // replaces it
  assert.equal((await deliver(completed(old.passport.sessionRef, { nullifier: "nullifier-2" }))).detail, "Superseded by a newer check");
});

test("passport: under the council's tiers a passport proof counts as verified, unless the council turns that off", async () => {
  const pay = async (no: string) => (await processInvoice(invoice({ invoiceNumber: no, amountUsd: 7000, poNumber: "PO-BIG" }))).checks.find((c) => c.id === "vendor_kyb")!;
  assert.equal((await pay("INV-P1")).verdict, "block", "$7,000 needs a verified vendor under the default tiers");

  const { passport } = await startPassport("vendor", "Northwind Cloud Ltd");
  await deliver(completed(passport.sessionRef));
  const ok = await pay("INV-P2");
  assert.equal(ok.verdict, "allow");
  assert.match(ok.reason, /passport \(Self\)/);

  const p = currentPolicy();
  const rules = Object.fromEntries(Object.entries(p).filter(([k]) => !["version", "hash", "createdAt"].includes(k))) as PolicyProposal["changes"];
  state().policies.push(makePolicy(p.version + 1, { ...rules, acceptPassportProof: false }));
  assert.equal((await pay("INV-P3")).verdict, "block", "Persona only: the passport proof no longer counts");
});
