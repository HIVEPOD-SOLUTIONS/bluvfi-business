import "./setup";
import "./setup-zk";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { processInvoice } from "../lib/agent";
import { evaluatePolicy, needsApproval } from "../lib/policy";
import { currentPolicy } from "../lib/store";
import type { Invoice } from "../lib/types";
import { bitsPass, checkStatement, compileProgram, expectedBits, makeJob, proveJob, verifyZk, VK_FILE, ZK_DIR } from "../lib/zk";
import { install, invoice, seed } from "./fakes";

beforeEach(() => {
  install();
  seed();
});

const ctx = { killSwitch: false, spentTodayUsd: 0 };
const cases: [string, Partial<Invoice>, { killSwitch?: boolean; spentTodayUsd?: number }][] = [
  ["routine", {}, {}],
  ["over the per-payment limit", { amountUsd: 12_000 }, {}],
  ["over the daily limit", { amountUsd: 6_000 }, { spentTodayUsd: 10_000 }],
  ["chain not permitted", { chain: "tron" }, {}],
  ["asset not permitted", { asset: "DAI" }, {}],
  ["vendor not allowlisted", { vendorName: "Unknown Vendor" }, {}],
  ["needs approval", { amountUsd: 7_000 }, {}],
  ["kill switch", {}, { killSwitch: true }],
];

test("zk: the circuit's check (mirrored) agrees with the app's policy gate on every case", () => {
  const policy = currentPolicy();
  for (const [name, over, c] of cases) {
    const inv = invoice(over);
    const pc = { ...ctx, ...c };
    const bits = expectedBits(makeJob("pay-x", inv, policy, pc));
    const checks = evaluatePolicy(inv, policy, pc);
    assert.equal(bitsPass(bits), !checks.some((x) => x.verdict === "block"), `${name}: pass/fail`);
    assert.equal(!!(bits & (1 << 5)), checks.find((x) => x.id === "allowlist")!.verdict === "allow", `${name}: allowlist`);
    assert.equal(!!(bits & (1 << 6)), needsApproval(inv, policy), `${name}: approval`);
  }
});

test("zk: the committed verification key is the circuit's", async () => {
  const committed = JSON.parse(readFileSync(VK_FILE, "utf8")) as { hash: string };
  assert.equal((await compileProgram()).hash, committed.hash, "zk/verification-key.json is stale: run npm run zk:vk");
});

test("zk: a real o1js proof verifies for its payment and for nothing else", async () => {
  const policy = currentPolicy();
  const job = makeJob("pay-zk-1", invoice({ amountUsd: 7_000 }), policy, ctx);
  await proveJob("pay-zk-1", job);

  const ok = await verifyZk("pay-zk-1", job);
  assert.equal(ok.status, "verified", ok.note);
  assert.equal(ok.outputBits, expectedBits(job));
  assert.match(ok.note, /policy check passes and needs a signer/);

  // The same proof presented for another payment: valid proof, wrong statement.
  const other = makeJob("pay-zk-2", invoice({ amountUsd: 7_000 }), policy, ctx);
  const proof = JSON.parse(readFileSync(join(ZK_DIR, "proofs", "pay-zk-1.json"), "utf8"));
  assert.match((await checkStatement(proof, other)).note, /different statement/);

  // Tampering with the public output breaks the proof itself.
  const { verify } = await import("../lib/zk-program");
  const vk = JSON.parse(readFileSync(VK_FILE, "utf8")) as { data: string };
  assert.equal(await verify({ ...proof, publicOutput: [String(expectedBits(job) ^ 1)] }, vk.data), false);
});

test("zk: each payment carries its statement; without a proof it is pending, never claimed", async () => {
  const p = await processInvoice(invoice({ invoiceNumber: "INV-ZK" }));
  assert.ok(p.zkJob);
  assert.equal(p.verified.zkProof?.status, "pending");
  assert.equal((await verifyZk(p.id, p.zkJob!)).status, "pending");
});
