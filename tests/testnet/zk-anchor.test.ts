import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCustody, resetCustodyCache } from "../../lib/custody";
import { anchorIssuers, anchorStatus, anchorTag, currentIssuerSet, issuerSetHash } from "../../lib/zk-anchor";
import { issuerPublicKey } from "../../lib/zk-claims";
import { proposalById, until, vote } from "./chain";
import { ACCOUNTS } from "./setup";

/**
 * The issuer set against a REAL Sputnik DAO on NEAR testnet: the agent files the proposal with its scoped key, the council approves it with
 * real votes, and the app then reads it back off the chain. Nothing is faked.
 */
const T = { timeout: 300_000 };

test("the issuer set is put to the DAO, and counts as anchored only once the council has approved it on chain", T, async () => {
  resetCustodyCache();
  assert.equal((await checkCustody()).ok, true);
  // A set unique to this run (the app plus one attester, two must sign), so an earlier run's approved proposal cannot stand in for it.
  const attesterKey = `B62qtestattester${Date.now()}`;
  process.env.ZK_ATTESTERS = `http://127.0.0.1:1|token-0123456789|${attesterKey}`;
  process.env.ZK_ATTEST_THRESHOLD = "2";
  const set = await currentIssuerSet();
  assert.deepEqual(set, { issuers: [await issuerPublicKey(), attesterKey], threshold: 2 });
  const other = { issuers: [...set.issuers, "B62qanotherattester"], threshold: 2 };
  assert.equal((await anchorStatus(set)).anchored, false);
  assert.equal((await anchorStatus(set)).status, "Not proposed yet");

  const filed = await anchorIssuers();
  const onchain = await until("the proposal on the DAO", async () => proposalById(filed.proposalId));
  assert.equal(onchain.proposer, ACCOUNTS.agent, "filed by the agent's scoped key");
  assert.ok(onchain.description.includes(anchorTag(set)));
  assert.equal(onchain.status, "InProgress");

  const own = await until("the status to show it", async () => { const s = await anchorStatus(set); return s.proposalId !== undefined ? s : undefined; });
  assert.deepEqual([own.anchored, own.status, own.proposalId], [false, "InProgress", filed.proposalId], "filed, not yet approved: not anchored");

  await vote(1, filed.proposalId, "VoteApprove");
  assert.equal((await anchorStatus(set)).anchored, false, "one council vote is not enough");
  await vote(2, filed.proposalId, "VoteApprove");
  await until("the DAO to approve it", async () => (await proposalById(filed.proposalId)).status === "Approved");
  const approved = await until("the app to see it", async () => { const s = await anchorStatus(set); return s.anchored ? s : undefined; });
  assert.equal(approved.proposalId, filed.proposalId);

  // A different set (another key, or another threshold) is not anchored by this approval.
  assert.equal((await anchorStatus(other)).anchored, false);
  assert.equal((await anchorStatus({ ...set, threshold: 1 })).anchored, false);
  // The order of keys and repeated keys do not change what is anchored.
  assert.equal(issuerSetHash({ issuers: [...set.issuers.slice().reverse(), ...set.issuers], threshold: 2 }), issuerSetHash(set));
});
