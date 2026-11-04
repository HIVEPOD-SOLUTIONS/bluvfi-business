import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { signProposal } from "../../lib/confidential";
import { checkConfidentialCompat } from "../../lib/confidential-check";
import { viewFn } from "../../lib/custody";

/**
 * A real confidential treasury on NEAR mainnet, read from the chain with nothing faked and no access to anyone's app: brqm8.sputnik-dao.near
 * has a login ("Authenticate DAO for confidential intents") that its council approved through NEAR's MPC signer. Our proposal format, and our
 * check of the signature, are held against it.
 */
const T = { timeout: 180_000 };
const DAO = "brqm8.sputnik-dao.near";

test("a real mainnet confidential treasury: its signing request is the one this app files, and its council's signature verifies", T, async () => {
  const r = await checkConfidentialCompat(DAO);
  assert.equal(r.verdict, "compatible", r.findings.filter((f) => f.ok === false).map((f) => f.text).join(" "));
  assert.match(r.derivedKey ?? "", /^ed25519:/);

  const login = r.signRequests.find((s) => s.kind === "treasury" && /Authenticate DAO/.test(s.description));
  assert.ok(login, "the DAO's own login is among its requests to the signer");
  assert.equal(login.status, "Approved");
  assert.equal(login.sameAsOurs, true, "the same signer, method, deposit, gas, path and domain as signProposal() builds");
  assert.equal(login.signatureVerified, true, "its MPC signature is on the chain and verifies under the DAO's key for that hash");

  // The other request is the same DAO using the signer for something else, and is not counted against it.
  assert.ok(r.signRequests.some((s) => s.kind === "other"));
});

test("our proposal reproduces a real one: same fields, byte for byte once decoded", T, async () => {
  const last = await viewFn<number>(DAO, "get_last_proposal_id");
  const proposals = await viewFn<{ id: number; kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] } } }[]>(DAO, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 });
  const theirs = proposals.find((p) => p.kind.FunctionCall?.receiver_id === "v1.signer" && JSON.parse(Buffer.from(p.kind.FunctionCall.actions[0].args, "base64").toString()).request.path === DAO)!;
  const their = theirs.kind.FunctionCall!.actions[0];
  const hash = JSON.parse(Buffer.from(their.args, "base64").toString()).request.payload_v2.Eddsa as string;
  const ours = signProposal(DAO, hash).FunctionCall.actions[0];
  assert.deepEqual([ours.method_name, ours.deposit, ours.gas], [their.method_name, their.deposit, their.gas]);
  assert.deepEqual(JSON.parse(Buffer.from(ours.args, "base64").toString()), JSON.parse(Buffer.from(their.args, "base64").toString()));
});

test("the agent check on the real policy: its council accounts are voters so they cannot be the agent, and a stranger is in no role", T, async () => {
  const policy = await viewFn<{ roles: { name: string; kind: { Group?: string[] } }[] }>(DAO, "get_policy");
  const group = (name: string) => policy.roles.find((r) => r.name === name)!.kind.Group!;
  // This small treasury has the same two accounts in every role (Requestor, Admin and Approver), so each of them can vote: neither may be the agent.
  const member = group("Requestor")[0];
  assert.ok(group("Approver").includes(member), "the real policy gives its Requestors the Approver role too");
  const voter = await checkConfidentialCompat(DAO, member);
  assert.ok(voter.findings.some((f) => f.ok === false && /can vote through the role/.test(f.text)));
  assert.equal(voter.verdict, "incompatible");
  // An account in no role is told which role to be added to.
  const stranger = await checkConfidentialCompat(DAO, "nobody-at-all.near");
  assert.ok(stranger.findings.some((f) => f.ok === false && /is not in a role that can file call proposals. Add it to the "Requestor" role/.test(f.text)));
  // (An agent that can file and cannot vote is the good case: tests/confidential-check.test.ts covers it, because no real member is one.)
});

test("an account that is not a Sputnik DAO is not a confidential treasury", T, async () => {
  const r = await checkConfidentialCompat("near");
  assert.equal(r.verdict, "incompatible");
  assert.match(r.findings[0].text, /not a Sputnik DAO/);
});
