import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signProposal } from "../lib/confidential";
import { checkConfidentialCompat } from "../lib/confidential-check";

/** The compatibility check's verdicts on treasuries that differ from the good one, using a stand-in for the NEAR RPC. */
const DAO = "acme.sputnik-dao.near";
const KEY = "ed25519:AUwJ9Xxe5BKf4fpKF7xuRK41jmpaZm3XLqX8ULx5Gtq4";

const role = (name: string, members: string[], permissions: string[]) => ({ name, kind: { Group: members }, permissions });
const GOOD = {
  proposal_bond: "0",
  roles: [
    role("Requestor", ["agent.near"], ["call:AddProposal", "transfer:AddProposal", "call:VoteRemove"]),
    role("Approver", ["maya.near", "devon.near"], ["call:VoteApprove", "call:VoteReject", "call:Finalize"]),
  ],
};

async function check(world: { policy?: unknown; proposals?: unknown[]; derive?: boolean }, agent?: string) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { params: { account_id: string; method_name: string } };
    const method = req.params.method_name;
    const out = (o: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: Array.from(Buffer.from(JSON.stringify(o))), logs: [] } }));
    if (method === "get_policy") return world.policy ? out(world.policy) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { error: "MethodNotFound" } }));
    if (method === "get_last_proposal_id") return out((world.proposals ?? []).length);
    if (method === "get_proposals") return out(world.proposals ?? []);
    if (method === "derived_public_key") return world.derive === false ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { error: "no key" } })) : out(KEY);
    return out(null);
  }) as typeof fetch;
  try {
    return await checkConfidentialCompat(DAO, agent);
  } finally {
    globalThis.fetch = real;
  }
}

const proposal = (id: number, kind: unknown, status = "InProgress") => ({ id, description: `request ${id}`, status, kind });
const HASH = "ab".repeat(32);

test("a good treasury with no signing history is compatible in principle, and says there is nothing to compare", async () => {
  const r = await check({ policy: GOOD }, "agent.near");
  assert.equal(r.verdict, "compatible_untested");
  assert.ok(r.findings.some((f) => f.ok === null && /nothing of its to compare/.test(f.text)));
  assert.ok(r.findings.every((f) => f.ok !== false));
});

test("a proposal bond above zero is refused: the agent's key attaches no deposit", async () => {
  const r = await check({ policy: { ...GOOD, proposal_bond: "100000000000000000000000" } });
  assert.equal(r.verdict, "incompatible");
  assert.ok(r.findings.some((f) => f.ok === false && /bond is 100000000000000000000000/.test(f.text)));
});

test("an agent that can vote, or that is in no role, is refused", async () => {
  const voter = await check({ policy: { ...GOOD, roles: [role("Everyone", ["agent.near"], ["call:AddProposal", "call:VoteApprove"])] } }, "agent.near");
  assert.equal(voter.verdict, "incompatible");
  assert.ok(voter.findings.some((f) => f.ok === false && /can vote through the role "Everyone"/.test(f.text)));
  const none = await check({ policy: GOOD }, "someone-else.near");
  assert.ok(none.findings.some((f) => f.ok === false && /Add it to the "Requestor" role/.test(f.text)));
});

test("a DAO where nobody can approve call proposals, or that has no filer role, is refused", async () => {
  const noApprover = await check({ policy: { ...GOOD, roles: [GOOD.roles[0]] } });
  assert.ok(noApprover.findings.some((f) => f.ok === false && /could never be approved/.test(f.text)));
  const noFiler = await check({ policy: { ...GOOD, roles: [GOOD.roles[1]] } });
  assert.ok(noFiler.findings.some((f) => f.ok === false && /needs a Requestor-style role/.test(f.text)));
});

test("a signing request that differs from ours, in gas or in path, is reported, and one for another path is not held against it", async () => {
  const ours = signProposal(DAO, HASH);
  const lowGas = JSON.parse(JSON.stringify(ours)) as typeof ours;
  lowGas.FunctionCall.actions[0].gas = "30000000000000";
  const other = signProposal(DAO, HASH, "v1.signer");
  const otherArgs = JSON.parse(Buffer.from(other.FunctionCall.actions[0].args, "base64").toString()) as { request: { path: string } };
  otherArgs.request.path = "bulk-payment";
  other.FunctionCall.actions[0].args = Buffer.from(JSON.stringify(otherArgs)).toString("base64");

  const same = await check({ policy: GOOD, proposals: [proposal(1, ours)] });
  assert.equal(same.verdict, "compatible");
  assert.equal(same.signRequests[0].sameAsOurs, true);

  const differs = await check({ policy: GOOD, proposals: [proposal(1, lowGas)] });
  assert.equal(differs.verdict, "incompatible");
  assert.equal(differs.signRequests[0].sameAsOurs, false);

  const elsewhere = await check({ policy: GOOD, proposals: [proposal(1, other)] });
  assert.equal(elsewhere.signRequests[0].kind, "other");
  assert.equal(elsewhere.verdict, "compatible_untested", "a request for another path is not the treasury's, so it neither helps nor hurts");
});

test("a DAO the MPC signer will not derive a key for is refused", async () => {
  const r = await check({ policy: GOOD, derive: false });
  assert.equal(r.verdict, "incompatible");
});

test("something that is not a DAO at all is not compatible", async () => {
  const r = await check({});
  assert.equal(r.verdict, "incompatible");
  assert.match(r.findings[0].text, /not a Sputnik DAO/);
});
