import "./setup";
import { KeyPair } from "near-api-js";
// A post-quantum agent key, in the form near-api-js and nearcore use (`ml-dsa-65:`). Set before lib modules load.
const AGENT_KEY = KeyPair.fromRandom("ml-dsa-65");
process.env.CUSTODY = "sputnik";
process.env.DAO_ACCOUNT = "acme.sputnik-dao.near";
process.env.AGENT_ACCOUNT = "acme-agent.near";
process.env.AGENT_PRIVATE_KEY = AGENT_KEY.toString();

import assert from "node:assert/strict";
import { test } from "node:test";

const DAO = "acme.sputnik-dao.near";
const view = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
const POLICY = {
  proposal_bond: "0",
  proposal_period: "604800000000000",
  roles: [
    { name: "council", kind: { Group: ["maya.near"] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:AddProposal"] },
    { name: "agent", kind: { Group: ["acme-agent.near"] }, permissions: ["call:AddProposal", "transfer:AddProposal"] },
  ],
};

test("custody: an ML-DSA-65 agent key is checked through the key list, where nearcore shows it as ml-dsa-65-hash", async () => {
  assert.match(AGENT_KEY.getPublicKey().toString(), /^ml-dsa-65:/);
  const singleKeyLookups: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    const p = req.params;
    if (p.request_type === "view_access_key") singleKeyLookups.push(String(p.public_key));
    if (p.request_type === "view_access_key_list") {
      const scoped = { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } };
      return ok({ keys: [{ public_key: "ml-dsa-65-hash:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", access_key: { nonce: 7, permission: scoped } }] });
    }
    if (p.method_name === "get_policy") return ok(view(POLICY));
    return ok({});
  }) as typeof fetch;
  try {
    const { checkCustody } = await import("../lib/custody");
    const c = await checkCustody();
    assert.equal(c.ok, true, c.problems.join(" "));
    assert.ok(c.facts.includes("Agent key is ML-DSA-65 (post-quantum); it is checked with the account's key list."));
    assert.ok(c.facts.some((f) => /^All 1 key on acme-agent\.near can only call add_proposal/.test(f)));
    assert.ok(c.facts.some((f) => /agent key ML-DSA/.test(f)));
    assert.equal(singleKeyLookups.length, 0, "no lookup by the full ML-DSA key");
  } finally {
    globalThis.fetch = real;
  }
});
