import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "./crypto";
import type { Invoice, Policy } from "./types";

/**
 * Zero-knowledge proof of the policy check, in TypeScript with o1js (lib/zk-program.ts). No contract and no
 * trusted hardware: the proof is a JSON file that anyone can verify against the program's verification key.
 *
 *   1. Every payment writes a job: the public statement of the policy check (.data/zk/jobs/<payment id>.json).
 *   2. A background process proves it (`npm run zk:prove`, about 15 s per proof) into .data/zk/proofs/<id>.json.
 *   3. This file verifies a proof against zk/verification-key.json, then requires its public statement to be
 *      exactly this payment's job and its output to equal the policy check computed here.
 */
export const ZK_DIR = process.env.BLUVFI_ZK_DIR ?? join(process.cwd(), ".data", "zk");
export const VK_FILE = join(process.cwd(), "zk", "verification-key.json");
export const SYSTEM = "o1js (Kimchi proof system)";

export const CHAINS = ["near", "eth", "arb", "base", "sol"];
export const ASSETS = ["USDC", "USDT"];
const code = (list: string[], v: string) => (list.includes(v) ? list.indexOf(v) : 31);
const mask = (list: string[], allowed: string[]) => allowed.reduce((m, v) => (list.includes(v) ? m | (1 << list.indexOf(v)) : m), 0);
const cents = (usd: number) => Math.round(usd * 100);
const nameHash = (name: string) => sha256(`vendor:${name}`);

/** The public statement of one policy check. Hashes are sha256 hex; in the circuit they are their first 31 bytes. */
export interface ZkJob {
  amount_cents: number;
  per_payment_limit_cents: number;
  daily_limit_cents: number;
  spent_today_cents: number;
  approval_threshold_cents: number;
  kill_switch: boolean;
  chain_code: number;
  allowed_chains_mask: number;
  asset_code: number;
  allowed_assets_mask: number;
  vendor: string;
  allowlist: string[];
  policy_hash: string;
  subject: string;
}

export interface ZkProofStatus {
  system: string;
  status: "pending" | "verified" | "invalid";
  note: string;
  outputBits?: number;
  proverSeconds?: number;
}

/** What the payment is: the proof is bound to it through `subject`. */
export const zkSubject = (paymentId: string, inv: Invoice) =>
  sha256(canonical({ payment: paymentId, invoice: inv.invoiceNumber, vendor: inv.vendorName, amountUsd: inv.amountUsd, chain: inv.chain, asset: inv.asset, payTo: inv.payoutAddress }));

export function makeJob(paymentId: string, inv: Invoice, policy: Policy, ctx: { killSwitch: boolean; spentTodayUsd: number }): ZkJob {
  return {
    amount_cents: cents(inv.amountUsd),
    per_payment_limit_cents: cents(policy.perPaymentLimitUsd),
    daily_limit_cents: cents(policy.dailyLimitUsd),
    spent_today_cents: cents(ctx.spentTodayUsd),
    approval_threshold_cents: cents(policy.approvalThresholdUsd),
    kill_switch: ctx.killSwitch,
    chain_code: code(CHAINS, inv.chain),
    allowed_chains_mask: mask(CHAINS, policy.allowedChains),
    asset_code: code(ASSETS, inv.asset),
    allowed_assets_mask: mask(ASSETS, policy.allowedAssets),
    vendor: nameHash(inv.vendorName),
    allowlist: policy.vendorAllowlist.map(nameHash),
    policy_hash: policy.hash,
    subject: zkSubject(paymentId, inv),
  };
}

/** The circuit's computation, in plain TypeScript: what a valid proof must output for this job. */
export function expectedBits(j: ZkJob): number {
  let b = 0;
  if (!j.kill_switch) b |= 1;
  if (j.amount_cents <= j.per_payment_limit_cents) b |= 1 << 1;
  if (j.spent_today_cents + j.amount_cents <= j.daily_limit_cents) b |= 1 << 2;
  if (j.chain_code < 32 && j.allowed_chains_mask & (1 << j.chain_code)) b |= 1 << 3;
  if (j.asset_code < 32 && j.allowed_assets_mask & (1 << j.asset_code)) b |= 1 << 4;
  if (j.allowlist.some((h) => h.slice(0, 62) === j.vendor.slice(0, 62))) b |= 1 << 5;
  if (j.amount_cents >= j.approval_threshold_cents) b |= 1 << 6;
  return b;
}

export const bitsPass = (bits: number) => (bits & 0b11111) === 0b11111;

const jobFile = (id: string) => join(ZK_DIR, "jobs", `${id}.json`);
const proofFile = (id: string) => join(ZK_DIR, "proofs", `${id}.json`);

export function writeJob(paymentId: string, job: ZkJob) {
  mkdirSync(join(ZK_DIR, "jobs"), { recursive: true });
  writeFileSync(jobFile(paymentId), JSON.stringify(job, null, 2));
}

// ---------- o1js: loaded only when proving or verifying ----------

// Everything o1js comes through lib/zk-program.ts, so only one copy of o1js is ever loaded.
const zk = () => import("./zk-program");

/** A sha256 hex digest as a field element: its first 31 bytes (248 bits, below the field size). */
const hashField = async (hex: string) => (await zk()).Field(BigInt(`0x${hex.slice(0, 62)}`));

/** The job as the circuit's public input. */
export async function statement(j: ZkJob) {
  const { Bool, Field, UInt64, MAX_ALLOWLIST, PolicyStatement } = await zk();
  if (j.allowlist.length > MAX_ALLOWLIST) throw new Error(`The proof covers at most ${MAX_ALLOWLIST} allowlisted vendors`);
  const list = await Promise.all(j.allowlist.map(hashField));
  return new PolicyStatement({
    subject: await hashField(j.subject),
    policyHash: await hashField(j.policy_hash),
    amountCents: UInt64.from(j.amount_cents),
    perPaymentLimitCents: UInt64.from(j.per_payment_limit_cents),
    dailyLimitCents: UInt64.from(j.daily_limit_cents),
    spentTodayCents: UInt64.from(j.spent_today_cents),
    approvalThresholdCents: UInt64.from(j.approval_threshold_cents),
    killSwitch: Bool(j.kill_switch),
    chainCode: Field(j.chain_code),
    allowedChainsMask: Field(j.allowed_chains_mask),
    assetCode: Field(j.asset_code),
    allowedAssetsMask: Field(j.allowed_assets_mask),
    vendor: await hashField(j.vendor),
    allowlist: [...list, ...Array.from({ length: MAX_ALLOWLIST - list.length }, () => Field(0))],
  });
}

let compiled: Promise<{ data: string; hash: string }> | undefined;

/** Compile the circuit (about 20 s the first time; the prover keys are cached in .data/zk/cache). */
export function compileProgram() {
  compiled ??= (async () => {
    const { Cache, PolicyCheck } = await zk();
    mkdirSync(join(ZK_DIR, "cache"), { recursive: true });
    const { verificationKey } = await PolicyCheck.compile({ cache: Cache.FileSystem(join(ZK_DIR, "cache")) });
    return { data: verificationKey.data, hash: verificationKey.hash.toString() };
  })();
  return compiled;
}

/** Prove one job and save the proof. Returns the time taken. */
export async function proveJob(paymentId: string, job: ZkJob): Promise<number> {
  await compileProgram();
  const { PolicyCheck } = await zk();
  const t0 = Date.now();
  const { proof } = await PolicyCheck.check(await statement(job));
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  mkdirSync(join(ZK_DIR, "proofs"), { recursive: true });
  writeFileSync(proofFile(paymentId), JSON.stringify({ ...proof.toJSON(), proverSeconds: seconds }));
  return seconds;
}

/**
 * Prove pending jobs in a separate process, so the app never waits for one. One prover runs at a time (see
 * scripts/zk-prove.ts) and works through the queue; the payment page picks each proof up when it appears.
 */
export function proveInBackground() {
  const child = spawn("npx", ["tsx", "scripts/zk-prove.ts"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("error", () => {}); // proving is best effort; the payment shows "pending" until a proof exists
  child.unref();
}

/** The committed verification key (zk/verification-key.json, from `npm run zk:vk`). */
function verificationKey(): { data: string; hash: string } | null {
  try {
    return JSON.parse(readFileSync(VK_FILE, "utf8")) as { data: string; hash: string };
  } catch {
    return null;
  }
}

/**
 * Check the proof for a payment, if there is one. Valid means: o1js verifies it against the committed
 * verification key, its public input is exactly this payment's statement, and its output is our policy result.
 */
export async function verifyZk(paymentId: string, job: ZkJob): Promise<ZkProofStatus> {
  if (!existsSync(proofFile(paymentId))) return { system: SYSTEM, status: "pending", note: "Statement written; the proof is being made in the background (about 15 seconds)." };
  const vk = verificationKey();
  if (!vk) return { system: SYSTEM, status: "pending", note: "A proof exists, but zk/verification-key.json is missing. Run `npm run zk:vk`." };
  const json = JSON.parse(readFileSync(proofFile(paymentId), "utf8")) as { publicInput: string[]; publicOutput: string[]; maxProofsVerified: 0 | 1 | 2; proof: string; proverSeconds?: number };
  const { verify } = await zk();
  if (!(await verify(json, vk.data))) return { system: SYSTEM, status: "invalid", note: "o1js rejected the proof." };
  return checkStatement(json, job, vk.hash);
}

/** The second half of verification: is this proof about this payment, with the right result? */
export async function checkStatement(json: { publicInput: string[]; publicOutput: string[]; proverSeconds?: number }, job: ZkJob, vkHash = ""): Promise<ZkProofStatus> {
  const { PolicyStatement } = await zk();
  const expected = PolicyStatement.toFields(await statement(job)).map(String);
  if (json.publicInput.length !== expected.length || json.publicInput.some((f, i) => f !== expected[i]))
    return { system: SYSTEM, status: "invalid", note: "The proof is valid, but for a different statement than this payment." };
  const bits = Number(json.publicOutput[0]);
  if (bits !== expectedBits(job)) return { system: SYSTEM, status: "invalid", note: `The proof outputs ${bits.toString(2)}, not ${expectedBits(job).toString(2)}.` };
  return {
    system: SYSTEM,
    status: "verified",
    outputBits: bits,
    proverSeconds: json.proverSeconds,
    note:
      `Verified with o1js against verification key ${vkHash.slice(0, 12)}…: for this payment under policy ${job.policy_hash.slice(0, 12)}…, ` +
      `the policy check ${bitsPass(bits) ? "passes" : "fails"}${bits & (1 << 6) ? " and needs a signer" : ""}. No trusted hardware involved.`,
  };
}
