import "./setup";
import "./setup-sputnik";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { approveProposal, daoPolicyTag, isPolicyCarrier, propose, syncDaoProposal } from "../lib/governance";
import { POLICY_VIA_DAO } from "../lib/config";
import { DEFAULT_POLICY_BODY, makePolicy, verifyPolicyHistory } from "../lib/policy";
import { currentPolicy } from "../lib/store";
import type { PolicyProposal } from "../lib/types";
import { install, seed, state } from "./fakes";

/** With Sputnik custody, policy changes are approved by the treasury DAO's council, read from the chain. */
const DAO = "acme.sputnik-dao.near";
let daoProposals: { id: number; status: string; kind: unknown; description: string }[] = [];

const view = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
const rpc = async (_url: string, init?: RequestInit) => {
  const req = JSON.parse(String(init?.body)) as { params: { account_id: string; method_name: string; args_base64: string } };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  assert.equal(req.params.account_id, DAO);
  if (req.params.method_name === "get_last_proposal_id") return ok(view(daoProposals.length));
  if (req.params.method_name === "get_proposals") {
    const { from_index, limit } = JSON.parse(Buffer.from(req.params.args_base64, "base64").toString());
    return ok(view(daoProposals.slice(from_index, from_index + limit)));
  }
  throw new Error(`unexpected view ${req.params.method_name}`);
};

let realFetch: typeof fetch;
beforeEach(() => {
  install();
  seed();
  daoProposals = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = rpc as unknown as typeof fetch;
});
test.afterEach(() => { globalThis.fetch = realFetch; });

const body = (over: Partial<PolicyProposal["changes"]> = {}): PolicyProposal["changes"] => ({
  ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, ...over,
});

test("with Sputnik custody a policy change waits for the DAO: app signers cannot approve it", () => {
  assert.equal(POLICY_VIA_DAO, true);
  state().policies = [makePolicy(1, body())];
  const changes = body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 });
  const p = propose(changes, "maya");
  assert.equal(p.status, "open");
  assert.equal(p.dao?.version, 2);
  assert.equal(p.dao?.tag, daoPolicyTag(2, changes));
  assert.match(p.dao!.description, /per payment \$2,000/);
  assert.match(p.dao!.command, /add_proposal/);
  assert.match(p.dao!.command, /get_last_proposal_id/);
  assert.deepEqual(Object.keys(p.dao!.kind as object), ["FunctionCall"]);
  assert.equal(isPolicyCarrier(p.dao!.kind), true);
  assert.throws(() => approveProposal(p.id, "devon"), /treasury DAO's council/);
  assert.equal(currentPolicy().version, 1);
});

test("the change applies only when the chain says the matching Vote proposal is Approved", async () => {
  state().policies = [makePolicy(1, body())];
  const changes = body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 });
  const p = propose(changes, "maya");

  await assert.rejects(() => syncDaoProposal(p.id), /No DAO proposal carries this change's tag/);

  daoProposals.push({ id: 0, status: "InProgress", kind: p.dao!.kind, description: `Policy. ${p.dao!.tag}` });
  assert.equal((await syncDaoProposal(p.id)).status, "open");
  assert.equal(p.dao?.proposalId, 0);
  assert.equal(p.dao?.daoStatus, "InProgress");
  assert.equal(currentPolicy().version, 1);

  daoProposals[0].status = "Approved";
  assert.equal((await syncDaoProposal(p.id)).status, "applied");
  assert.equal(currentPolicy().version, 2);
  assert.equal(currentPolicy().perPaymentLimitUsd, 2000);
  assert.deepEqual(verifyPolicyHistory(state().policies), { ok: true, problems: [] });
});

test("only the carrier shape counts: not a transfer-like call, not another receiver, not different rules, not a rejected one", async () => {
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  const other = propose(body({ perPaymentLimitUsd: 9999, dailyLimitUsd: 9999 }), "maya");
  const call = (receiver_id: string, method_name: string) => ({ FunctionCall: { receiver_id, actions: [{ method_name }] } });

  daoProposals.push({ id: 0, status: "Approved", kind: call(DAO, "ft_transfer"), description: p.dao!.tag }); // a real call that quotes the tag
  daoProposals.push({ id: 1, status: "Approved", kind: call("evil.near", "get_last_proposal_id"), description: p.dao!.tag }); // wrong receiver
  daoProposals.push({ id: 2, status: "Approved", kind: other.dao!.kind, description: other.dao!.tag }); // approved, but for other rules
  daoProposals.push({ id: 3, status: "Approved", kind: { Transfer: {} }, description: p.dao!.tag });
  await assert.rejects(() => syncDaoProposal(p.id), /No DAO proposal carries/);
  assert.equal(currentPolicy().version, 1);
  assert.equal(p.status, "open");

  daoProposals.push({ id: 4, status: "Rejected", kind: p.dao!.kind, description: p.dao!.tag });
  assert.equal((await syncDaoProposal(p.id)).status, "rejected");
  assert.equal(currentPolicy().version, 1);
});

test("a plain Vote proposal is accepted too, for DAOs that have that kind", async () => {
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 2500, dailyLimitUsd: 5000 }), "maya");
  daoProposals.push({ id: 0, status: "Approved", kind: "Vote", description: p.dao!.tag });
  assert.equal((await syncDaoProposal(p.id)).status, "applied");
});

test("a change drafted against an older policy is stale once another change has applied", async () => {
  state().policies = [makePolicy(1, body())];
  const first = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  const second = propose(body({ perPaymentLimitUsd: 3000, dailyLimitUsd: 5000 }), "maya");
  daoProposals.push({ id: 0, status: "Approved", kind: first.dao!.kind, description: first.dao!.tag });
  daoProposals.push({ id: 1, status: "Approved", kind: second.dao!.kind, description: second.dao!.tag });
  await syncDaoProposal(first.id);
  assert.equal(currentPolicy().version, 2);
  await assert.rejects(() => syncDaoProposal(second.id), /policy changed/i);
  assert.equal(currentPolicy().perPaymentLimitUsd, 2000);
});
