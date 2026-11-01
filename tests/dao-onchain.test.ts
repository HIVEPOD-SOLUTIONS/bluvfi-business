import "./setup";
import "./setup-sputnik";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { approvalsNeeded, checkCustody, resetCustodyCache } from "../lib/custody";
import { DEFAULT_POLICY_BODY, makePolicy } from "../lib/policy";
import { propose, proposeToDao } from "../lib/governance";
import { install, seed, state } from "./fakes";

/** What the app reads from the DAO and does with its scoped key, against a fake NEAR RPC (no real chain here). */
const DAO = "acme.sputnik-dao.near";
const scoped = { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } };

type Role = { name: string; kind: unknown; permissions: string[]; vote_policy?: Record<string, unknown> };
let roles: Role[] = [];
let threshold: unknown = [1, 2];
let permission: unknown = scoped;
let sent: unknown[] = [];

const COUNCIL: Role = { name: "council", kind: { Group: ["maya.near", "devon.near", "sam.near"] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:AddProposal"], vote_policy: {} };
const AGENT: Role = { name: "requestor", kind: { Group: ["acme-agent.near"] }, permissions: ["call:AddProposal", "transfer:AddProposal"], vote_policy: {} };

const view = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
const rpc = async (_url: string, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  if (req.method === "query" && req.params.request_type === "view_access_key") return ok({ nonce: 7, permission, block_height: 1, block_hash: "11111111111111111111111111111111" });
  if (req.method === "query" && req.params.request_type === "call_function") {
    if (req.params.method_name === "get_policy")
      return ok(view({ proposal_bond: "0", proposal_period: "604800000000000", roles, default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold } }));
  }
  if (req.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100 } });
  if (req.method === "send_tx" || req.method === "broadcast_tx_commit") {
    sent.push(req.params);
    return ok({
      final_execution_status: "FINAL",
      status: { SuccessValue: Buffer.from("7").toString("base64") },
      transaction: { hash: "TxHash111" },
      transaction_outcome: { id: "TxHash111", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } },
      receipts_outcome: [],
    });
  }
  return ok({});
};

let realFetch: typeof fetch;
beforeEach(() => {
  install();
  seed();
  resetCustodyCache();
  roles = [COUNCIL, AGENT];
  threshold = [1, 2];
  permission = scoped;
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = rpc as unknown as typeof fetch;
});
test.afterEach(() => { globalThis.fetch = realFetch; });

test("the approval threshold the DAO applies is read from the chain and reported", async () => {
  threshold = [1, 2]; // more than half of 3 = 2
  assert.match((await checkCustody()).facts.join("\n"), /executes a payout on 2 of 3 council approvals, enforced onchain/);
  resetCustodyCache();
  roles = [{ ...COUNCIL, vote_policy: { call: { weight_kind: "RoleWeight", quorum: "0", threshold: "3" } } }, AGENT]; // the role's own policy wins
  assert.match((await checkCustody()).facts.join("\n"), /on 3 of 3 council approvals/);
  resetCustodyCache();
  threshold = "1";
  roles = [COUNCIL, AGENT];
  assert.match((await checkCustody()).facts.join("\n"), /Note: .* any single council member can approve/);
  assert.equal(approvalsNeeded({ threshold: [1, 2] }, 3), 2);
  assert.equal(approvalsNeeded({ threshold: [2, 3] }, 3), 3);
  assert.equal(approvalsNeeded({ threshold: "2", quorum: "3" }, 3), 3);
});

test("separation of duties: an agent with voting rights through a DAO role fails the custody check", async () => {
  const ok = await checkCustody();
  assert.equal(ok.ok, true);
  assert.match(ok.facts.join("\n"), /holds no voting rights/);
  resetCustodyCache();
  roles = [COUNCIL, { ...AGENT, permissions: ["call:AddProposal", "call:VoteApprove"] }];
  const bad = await checkCustody();
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(" "), /holds voting rights through the DAO role "requestor" \(call:VoteApprove\)/);
  resetCustodyCache();
  roles = [COUNCIL, { ...AGENT, permissions: ["*:*"] }];
  assert.equal((await checkCustody()).ok, false); // a wildcard includes voting
});

test("the council's onchain hard stop is generated from the live policy: the agent leaves its role", async () => {
  const c = await checkCustody();
  // The agent is alone in its role, so the whole role is removed.
  assert.match(c.councilKill!, /ChangePolicyRemoveRole/);
  assert.match(c.councilKill!, /"role":"requestor"/);
  assert.match(c.councilKill!, /add_proposal/);
  resetCustodyCache();
  roles = [COUNCIL, { ...AGENT, kind: { Group: ["acme-agent.near", "other-bot.near"] } }];
  const shared = await checkCustody();
  // Others share the role, so it is updated without the agent and keeps their permissions.
  assert.match(shared.councilKill!, /ChangePolicyAddOrUpdateRole/);
  assert.match(shared.councilKill!, /"Group":\["other-bot.near"\]/);
  assert.doesNotMatch(shared.councilKill!.replace(/acme-agent\.near from the/, ""), /"Group":\[[^\]]*acme-agent/);
});

test("once the council removes the agent from its role, the app stops submitting on its own", async () => {
  assert.equal((await checkCustody()).ok, true);
  resetCustodyCache(); // the check is cached for minutes; a later check sees the new policy
  roles = [COUNCIL];
  const after = await checkCustody();
  assert.equal(after.ok, false);
  assert.match(after.problems.join(" "), /no DAO role allowed to add call proposals/);
});

test("the agent files a policy change with its scoped key; a failed custody check refuses it", async () => {
  state().policies = [makePolicy(1, { ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0 })];
  const p = propose({ ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }, "maya");

  permission = "FullAccess";
  await assert.rejects(() => proposeToDao(p.id), /Custody check failed/);
  assert.equal(sent.length, 0);

  resetCustodyCache();
  permission = scoped;
  const filed = await proposeToDao(p.id);
  assert.equal(sent.length, 1);
  assert.equal(filed.dao?.proposalId, 7); // the id the DAO returned
  await assert.rejects(() => proposeToDao(p.id), /Already sent/);
});
