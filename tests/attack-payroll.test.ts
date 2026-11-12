import "./setup-demo";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as attackPost } from "../app/api/attack/route";
import { setKillSwitch } from "../lib/agent";
import { demoDao } from "../lib/custody";
import { ATTACKS, runAttacks, runDemo } from "../lib/demo-scenario";
import { historyEntries } from "../lib/history";
import { createPayrollRun, demoPayrollVote, parsePayrollCsv, PER_PROPOSAL, refreshPayrollRun, SAMPLE_CSV, sendPayrollRun } from "../lib/payroll";
import { COOKIE, issueSession } from "../lib/session";
import { currentPolicy, state } from "../lib/store";
import { NEAR_USDC_CONTRACT } from "../lib/chains";

// ---------- The Attack lab ----------

test("attacks: the blunt injection, the fooled AI and the perfect forgery are all stopped, by different layers", async () => {
  const r = await runDemo({ vendorReplies: true });
  const [drain, fooled, forgery] = r.attacks;
  assert.equal(drain.status, "blocked");
  assert.equal(drain.ai.decision, "block");
  for (const id of ["limit", "daily", "injection"]) assert.ok(drain.checks.some((c) => c.id === id && c.verdict === "block"), id);

  // The AI said pay, with a valid signature: the deterministic injection check blocks it anyway.
  assert.equal(fooled.ai.decision, "pay");
  assert.ok(fooled.verified.signature.valid);
  assert.equal(fooled.checks.find((c) => c.id === "ai")!.verdict, "allow");
  assert.equal(fooled.status, "blocked");
  assert.ok(fooled.checks.some((c) => c.id === "injection" && c.verdict === "block"));

  // No tricks at all and the AI fooled again: still not paid, held for a human by the rules and the fraud signals.
  assert.equal(forgery.ai.decision, "pay");
  assert.equal(forgery.status, "held");
  assert.ok(forgery.checks.some((c) => c.id === "allowlist" && c.verdict === "warn"));
  assert.ok(forgery.checks.some((c) => c.id === "counterparty" && c.verdict !== "allow"));
  assert.ok(!r.attacks.some((p) => p.custody), "no attack ever reached the custodian");
  assert.deepEqual(ATTACKS.map((a) => a.invoice.payoutAddress), ["attacker.near", "attacker.near", "attacker.near"]);
});

test("attacks can be run again from the Attack lab, by a signer, in demo mode only", async () => {
  const cookie = `${COOKIE}=${encodeURIComponent((await issueSession("maya"))!)}`;
  const post = (c?: string) => attackPost(new Request("https://x.example/api/attack", { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: "{}" }), undefined) as Promise<Response>;
  assert.equal((await post()).status, 400, "not signed in");
  const res = await post(cookie);
  const out = (await res.json()) as { attacks: { status: string; ai: string }[] };
  assert.deepEqual(out.attacks.map((a) => a.status), ["blocked", "blocked", "held"]);
  assert.equal((await runAttacks()).length, 3);
});

// ---------- Payroll ----------

beforeEach(() => {
  state().payrollRuns = [];
  state().killSwitch = false;
  state().blocklist = state().blocklist.filter((b) => b.id !== "b1");
});

test("payroll sheet: columns by name, chain names people use, quoted fields, and every problem reported by line", async () => {
  const ok = await parsePayrollCsv('﻿Employee,Amount (USD),Network,Stablecoin,Wallet\n"Okafor, Ada","$4,200",Base,usdc,0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nBruno,3800,Solana,,7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rows.map((r) => [r.name, r.amountUsd, r.chain, r.asset]), [["Okafor, Ada", 4200, "base", "USDC"], ["Bruno", 3800, "sol", "USDC"]]);

  const bad = await parsePayrollCsv("name,amount,chain,asset,address\nA,abc,base,USDC,0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nB,10,base,USDC,not-an-address\nC,10,dogechain,USDC,x\nD,10,base,USDT,0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nE,10,near,USDC,Has Spaces.near");
  assert.equal(bad.errors.length, 5);
  assert.match(bad.errors[0], /^Line 2 \(A\): "abc" is not an amount/);
  assert.match(bad.errors[1], /Line 3 \(B\): "not-an-address" is not a Base address/);
  assert.match(bad.errors[2], /"dogechain" is not a chain we pay on/);
  assert.match(bad.errors[3], /USDT on Base is not a route/);
  assert.match((await parsePayrollCsv("who,how much\nA,1")).errors[0], /must name the columns/);
});

test("payroll checks every person: the council's allowed chains, the shared blocklist, the same address twice; a blocked line stops the run", async () => {
  state().blocklist.push({ id: "b1", kind: "address", value: "chen-wei.near", reason: "reported scam", evidenceHash: "", reportedBy: "x", at: "" });
  const extra = `${SAMPLE_CSV}\nAda again,100,base,USDC,0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`;
  const run = await createPayrollRun(extra, "November", "maya");
  assert.equal(run.totalUsd, 4200 + 3800 + 5100 + 2950 + 100);
  const chen = run.rows.find((r) => r.name === "Chen Wei")!;
  assert.equal(chen.verdict, "block");
  assert.equal(run.rows.find((r) => r.name === "Ada again")!.verdict, "warn", "same address twice is a warning");
  await assert.rejects(sendPayrollRun(run.id, "maya"), /Fix or remove Chen Wei first \(line 4\)/);
  assert.equal(run.status, "draft", "nothing was proposed");
  await assert.rejects(createPayrollRun(SAMPLE_CSV, "x", "mallory"), /Only a signer/);
});

test("payroll: one council approval pays everyone; each person's money goes through NEAR Intents to their own chain", async () => {
  const run = await createPayrollRun(SAMPLE_CSV, "November salaries", "maya");
  assert.ok(run.rows.every((r) => r.status === "ready"));
  await sendPayrollRun(run.id, "maya");
  assert.equal(run.status, "proposed");
  assert.equal(run.proposals.length, 1, "four people: one proposal");
  const prop = demoDao().get(run.proposals[0].id);
  const kind = prop.kind as { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } };
  assert.equal(kind.FunctionCall.receiver_id, NEAR_USDC_CONTRACT);
  assert.deepEqual(kind.FunctionCall.actions.map((a) => a.method_name), ["storage_deposit", "ft_transfer", "storage_deposit", "ft_transfer", "storage_deposit", "ft_transfer", "storage_deposit", "ft_transfer"]);
  const transfers = kind.FunctionCall.actions.filter((a) => a.method_name === "ft_transfer").map((a) => JSON.parse(Buffer.from(a.args, "base64").toString()) as { receiver_id: string; memo: string });
  assert.deepEqual(transfers.map((t) => t.receiver_id), run.rows.map((r) => r.quote!.depositAddress), "each to that person's own deposit address");
  assert.match(transfers[0].memo, new RegExp(`^bluvfi-payroll:${run.id}:2$`));
  for (const r of run.rows) assert.ok(prop.description.includes(r.name), `${r.name} is named in the proposal`);
  assert.ok(prop.description.includes(run.evidenceHash!));

  await demoPayrollVote(run.id, "maya", true);
  assert.equal(run.rows[0].status, "proposed", "one vote is not enough");
  await demoPayrollVote(run.id, "devon", true);
  assert.equal(run.status, "done");
  assert.ok(run.rows.every((r) => r.status === "paid"), JSON.stringify(run.rows.map((r) => r.status)));
  const h = historyEntries().filter((e) => e.category === "payroll");
  assert.deepEqual(h.map((e) => e.status), ["Paid", "Paid", "Paid", "Paid"]);
  await assert.rejects(sendPayrollRun(run.id, "maya"), /already proposed|already done/);
});

test("a bigger team is split into proposals of a few people each, and a rejected one pays nobody in it", async () => {
  const lines = Array.from({ length: 2 * PER_PROPOSAL + 3 }, (_, i) => `P${i},100,near,USDC,person-${i}.near`);
  const run = await createPayrollRun(`name,amount,chain,asset,address\n${lines.join("\n")}`, "Big team", "maya");
  await sendPayrollRun(run.id, "maya");
  assert.equal(run.proposals.length, 3);
  assert.deepEqual(run.proposals.map((p) => p.rows.length), [PER_PROPOSAL, PER_PROPOSAL, 3]);
  await demoPayrollVote(run.id, "maya", false);
  await demoPayrollVote(run.id, "devon", false);
  assert.ok(run.rows.every((r) => r.status === "rejected"));
  assert.equal(run.status, "done");
});

test("nothing is sent with the kill switch on, and a deposit address that expired before the vote is flagged", async () => {
  const run = await createPayrollRun(SAMPLE_CSV, "Dec", "maya");
  setKillSwitch(true, "maya");
  await assert.rejects(sendPayrollRun(run.id, "maya"), /kill switch/);
  setKillSwitch(false, "maya");
  await sendPayrollRun(run.id, "maya");
  for (const r of run.rows) r.quote!.timeWhenInactive = new Date(Date.now() - 60_000).toISOString();
  await refreshPayrollRun(run.id);
  assert.ok(run.rows.every((r) => r.status === "expired"));
  assert.match(run.rows[0].note!, /Reject this proposal in Trezu/);
  assert.equal(currentPolicy().allowedChains.includes("near"), true);
});
