import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";
import { checkCustody, refreshPayout, relayVote, resetCustodyCache, submitPayout } from "../../lib/custody";
import { NEAR_USDC_CONTRACT } from "../../lib/chains";
import { approveProposal, isPolicyCarrier, propose, proposeToDao, syncDaoProposal } from "../../lib/governance";
import { DEFAULT_POLICY_BODY, makePolicy, verifyPolicyHistory } from "../../lib/policy";
import { currentPolicy, resetState, state } from "../../lib/store";
import type { Payment, PolicyProposal } from "../../lib/types";
import { addProposal, proposalById, provider, until, vote } from "./chain";
import { ACCOUNTS, DAO, keys } from "./setup";

/**
 * Layer 1 against a REAL Sputnik DAO on NEAR testnet (see scripts/testnet-setup.ts). No fake RPC, no fake chain:
 * every call below is a real transaction or view, signed by the real council members and the real scoped agent key.
 */
const T = { timeout: 240_000 };
const body = (over: Partial<PolicyProposal["changes"]> = {}): PolicyProposal["changes"] => ({
  ...DEFAULT_POLICY_BODY, vendorAllowlist: ["Northwind Cloud Ltd"], holdWindowMinutes: 0, ...over,
});
const agentOnChain = () => new Account(ACCOUNTS.agent, new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }), keys.agentScoped.secret as KeyPairString);

async function custody() {
  resetCustodyCache();
  return checkCustody();
}

test("custody check against the real DAO: scoped key, bond 0, no voting rights, 2-of-3 threshold, council hard stop", T, async () => {
  const c = await custody();
  assert.deepEqual(c.problems, []);
  assert.equal(c.ok, true);
  const facts = c.facts.join("\n");
  assert.match(facts, /function-call only/i);
  assert.match(facts, /bond is 0/i);
  assert.match(facts, /holds no voting rights/);
  assert.match(facts, /executes a payout on 2 of 3 council approvals, enforced onchain/);
  for (const n of [1, 2, 3]) assert.ok(facts.includes(ACCOUNTS[`council${n}`]), `council member ${n} listed`);
  assert.match(c.councilKill ?? "", /ChangePolicyRemoveRole/);
});

test("what the agent's key can and cannot do, proven by the chain rejecting it", T, async () => {
  const agent = agentOnChain();
  // It cannot vote: the key is limited to add_proposal.
  await assert.rejects(() => agent.callFunction({ contractId: DAO, methodName: "act_proposal", args: { id: 0, action: "VoteApprove" }, gas: teraToGas(50), deposit: BigInt(0) }));
  // It cannot move funds, or add keys.
  await assert.rejects(() => agent.transfer({ receiverId: ACCOUNTS.relayer, amount: BigInt("1000000000000000000000") }));
  await assert.rejects(() => agent.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey()));
  // It can propose a payout-shaped call, but the DAO refuses a policy change from it (its role lacks that permission).
  await assert.rejects(() =>
    agent.callFunction({ contractId: DAO, methodName: "add_proposal", args: { proposal: { description: "agent tries to remove the council", kind: { ChangePolicyRemoveRole: { role: "council" } } } }, gas: teraToGas(50), deposit: BigInt(0) })
  );
  // And it holds exactly one key.
  const list = await agent.getAccessKeyList();
  assert.equal(list.keys.length, 1);
  assert.equal(list.keys[0].public_key, keys.agentScoped.publicKey);
});

test("a policy change: the agent files it, the council approves it onchain, then the app applies it", T, async () => {
  resetState();
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  assert.equal(p.dao?.version, 2);
  assert.throws(() => approveProposal(p.id, "devon"), /treasury DAO's council/); // app signers cannot approve it

  const filed = await proposeToDao(p.id);
  const id = filed.dao!.proposalId!;
  const onchain = await until("the proposal on the DAO", async () => proposalById(id));
  assert.equal(onchain.proposer, ACCOUNTS.agent);
  assert.ok(onchain.description.includes(p.dao!.tag));
  assert.equal(isPolicyCarrier(onchain.kind), true);
  assert.equal(onchain.status, "InProgress");

  // Not applied while it is in progress, or after one approval (the DAO needs 2 of 3).
  assert.equal((await until("sync sees it", async () => syncDaoProposal(p.id))).status, "open");
  await vote(1, id, "VoteApprove");
  assert.equal((await syncDaoProposal(p.id)).status, "open");
  assert.equal(currentPolicy().version, 1);

  await vote(2, id, "VoteApprove");
  await until("the DAO to approve it", async () => (await proposalById(id)).status === "Approved");
  const done = await until("the app to apply it", async () => {
    const r = await syncDaoProposal(p.id);
    return r.status === "applied" ? r : undefined;
  });
  assert.equal(done.dao?.daoStatus, "Approved");
  assert.equal(currentPolicy().version, 2);
  assert.equal(currentPolicy().perPaymentLimitUsd, 2000);
  assert.deepEqual(verifyPolicyHistory(state().policies), { ok: true, problems: [] });
});

test("a change the council rejects never applies", T, async () => {
  resetState();
  state().policies = [makePolicy(1, body())];
  const p = propose(body({ perPaymentLimitUsd: 9000, dailyLimitUsd: 9000 }), "maya");
  const id = (await proposeToDao(p.id)).dao!.proposalId!;
  await until("the proposal on the DAO", async () => proposalById(id));
  await vote(1, id, "VoteReject");
  await vote(2, id, "VoteReject");
  await until("the DAO to reject it", async () => (await proposalById(id)).status === "Rejected");
  const r = await until("sync", async () => {
    const x = await syncDaoProposal(p.id);
    return x.status === "rejected" ? x : undefined;
  });
  assert.equal(r.status, "rejected");
  assert.equal(currentPolicy().version, 1);
});

test("a payout proposal from the agent lands on the real DAO with its evidence, and the council's rejection is followed", T, async () => {
  resetState();
  const payment = {
    id: "pay-testnet-1", status: "approved", confidentiality: "basic", createdAt: new Date().toISOString(), headline: "", reason: "", rail: "intents",
    invoice: { id: "inv", invoiceNumber: "INV-TESTNET-1", vendorName: "Northwind Cloud Ltd", vendorDomain: "northwind.io", vendorContact: { channel: "email", handle: "" }, poNumber: "", amountUsd: 12.5, asset: "USDC", chain: "near", payoutAddress: ACCOUNTS.relayer, text: "", receivedAt: new Date().toISOString() },
    quote: { depositAddress: ACCOUNTS.relayer, amountIn: "12.5", amountOut: "12.5", source: "1click" },
    ai: { decision: "pay", riskScore: 3, summary: "", reasons: [] },
    checks: [{ id: "kill", label: "Kill switch", verdict: "allow", reason: "" }],
    verified: { policyVersion: 1, policyHash: "0".repeat(64), signature: { signingAddress: "test-signer", signature: "test-signature" } },
  } as unknown as Payment;

  resetCustodyCache();
  const rec = await submitPayout(payment);
  assert.equal(rec.backend, "sputnik");
  const id = Number(rec.ref);
  const onchain = await until("the payout proposal", async () => proposalById(id));
  assert.equal(onchain.proposer, ACCOUNTS.agent);
  const fc = (onchain.kind as { FunctionCall: { receiver_id: string; actions: { method_name: string }[] } }).FunctionCall;
  assert.equal(fc.receiver_id, NEAR_USDC_CONTRACT);
  assert.deepEqual(fc.actions.map((a) => a.method_name), ["storage_deposit", "ft_transfer"]);
  assert.ok(onchain.description.includes(rec.evidenceHash.slice(0, 16)) || onchain.description.includes(rec.evidenceHash));

  await until("the app to see it open", async () => (await refreshPayout(rec)).state === "pending");
  await vote(1, id, "VoteReject");
  await vote(2, id, "VoteReject");
  await until("the DAO to reject the payout", async () => (await proposalById(id)).status === "Rejected");
  const after = await until("the app to follow it", async () => {
    const r = await refreshPayout(rec);
    return r.state === "rejected" ? r : undefined;
  });
  assert.equal(after.state, "rejected");
});

test("the council's onchain hard stop: it removes the agent from its role, and the agent can no longer propose", T, async () => {
  const c = await custody();
  const args = /json-args '(.*)' prepaid-gas/.exec(c.councilKill ?? "")?.[1];
  assert.ok(args, "the hard-stop command carries its proposal");
  const { proposal } = JSON.parse(args!) as { proposal: { description: string; kind: unknown } };

  // Always put the role back, so the shared testnet treasury is usable for the next run.
  const restore = {
    ChangePolicyAddOrUpdateRole: { role: { name: "requestor", kind: { Group: [ACCOUNTS.agent] }, permissions: ["call:AddProposal", "transfer:AddProposal"], vote_policy: {} } },
  };
  try {
    const id = await addProposal(1, proposal.description, proposal.kind);
    await vote(1, id, "VoteApprove");
    await vote(2, id, "VoteApprove");
    await until("the DAO to approve the hard stop", async () => (await proposalById(id)).status === "Approved");

    const stopped = await until("the custody check to notice", async () => {
      const r = await custody();
      return r.ok ? undefined : r;
    });
    assert.match(stopped.problems.join(" "), /no DAO role allowed to add call proposals/);
    // The chain agrees: the agent's key now fails to propose.
    await assert.rejects(() =>
      agentOnChain().callFunction({ contractId: DAO, methodName: "add_proposal", args: { proposal: { description: "after the hard stop", kind: { Transfer: { token_id: "", receiver_id: ACCOUNTS.relayer, amount: "1" } } } }, gas: teraToGas(50), deposit: BigInt(0) })
    );
  } finally {
    const rid = await addProposal(1, "Bluvfi Business: restore the agent's Requestor role after the kill-switch test", restore);
    await vote(1, rid, "VoteApprove");
    await vote(2, rid, "VoteApprove");
    await until("the role to come back", async () => (await proposalById(rid)).status === "Approved");
  }
  const back = await until("custody to pass again", async () => {
    const r = await custody();
    return r.ok ? r : undefined;
  });
  assert.equal(back.ok, true);
});

test("an old approval cannot be replayed: the same rules, drafted again on a fresh state, find no matching approved proposal", T, async () => {
  // The earlier test left an APPROVED proposal for exactly these rules on the real DAO.
  resetState();
  state().policies = [makePolicy(1, body())]; // a new v1: its hash differs from the one that proposal was approved against
  const p = propose(body({ perPaymentLimitUsd: 2000, dailyLimitUsd: 4000 }), "maya");
  await assert.rejects(() => syncDaoProposal(p.id), /No DAO proposal carries this change's tag/);
  assert.equal(currentPolicy().version, 1);
});

test("gasless vote on the real DAO: a council member signs a NEP-366 delegate action, the relayer pays the gas, the vote counts", T, async () => {
  const key = KeyPair.fromString(keys.council1.secret as KeyPairString);
  const signer = new KeyPairSigner(key);
  const ids = await addProposal(2, "Bluvfi Business: a gasless-vote test proposal (does nothing)", "Vote");

  const build = async (over: { receiver?: string; method?: string; sender?: string } = {}) => {
    const ak = await provider.viewAccessKey({ accountId: ACCOUNTS.council1, publicKey: key.getPublicKey().toString(), finality: "final" } as never);
    const block = await provider.viewBlock({ finality: "final" });
    const da = buildDelegateAction({
      senderId: over.sender ?? ACCOUNTS.council1,
      receiverId: over.receiver ?? DAO,
      actions: [actions.functionCall(over.method ?? "act_proposal", { id: ids, action: "VoteApprove" }, BigInt(100e12), BigInt(0))],
      nonce: BigInt(ak.nonce) + BigInt(1),
      maxBlockHeight: BigInt(block.header.height) + BigInt(200),
      publicKey: key.getPublicKey(),
    } as never);
    const { signedDelegate } = await signer.signDelegateAction(da as never);
    return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  };

  // The relayer refuses anything but one act_proposal vote on our DAO from a council member.
  await assert.rejects(async () => relayVote(await build({ receiver: ACCOUNTS.relayer })), /Only votes on our DAO/);
  await assert.rejects(async () => relayVote(await build({ method: "add_proposal" })), /single act_proposal/);
  await assert.rejects(async () => relayVote(await build({ sender: ACCOUNTS.agent })), /not on the DAO council/);

  const before = (await memberBalance()).toString();
  const out = await relayVote(await build());
  assert.equal(out.sender, ACCOUNTS.council1);
  const p = await until("the relayed vote to show", async () => {
    const x = await proposalById(ids);
    return x.votes[ACCOUNTS.council1] === "Approve" ? x : undefined;
  });
  assert.equal(p.votes[ACCOUNTS.council1], "Approve");
  assert.equal((await memberBalance()).toString(), before, "the voter paid no gas: the relayer did");
});

async function memberBalance() {
  return new Account(ACCOUNTS.council1, provider, keys.council1.secret as KeyPairString).getBalance();
}
