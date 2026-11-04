import { DAO } from "./setup";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { daoDerivedKey, findMpcSignature, mpcSignature, signProposal, verifyMpcSignature, SIGNER_CONTRACT } from "../../lib/confidential";
import { addProposal, proposalById, until, voteWithOutcome } from "./chain";

/**
 * The DAO signs through NEAR's real MPC signer on testnet: the council approves a proposal that asks `v1.signer` to sign a
 * hash, and the signature that comes back verifies under the key the signer derives for this DAO. This is the step that
 * logs a confidential treasury in and authorises each of its confidential payouts. Nothing is mocked.
 */
const T = { timeout: 180_000 };

test("the council has the MPC signer sign a hash for the DAO, and the signature verifies under the DAO's derived key", T, async () => {
  assert.equal(SIGNER_CONTRACT, "v1.signer-prod.testnet", "the testnet signer is used on testnet");
  const hashHex = createHash("sha256").update(`bluvfi confidential test ${Date.now()}`).digest("hex");
  const key = await daoDerivedKey(DAO);
  assert.match(key, /^ed25519:/);

  // The agent could file this (it only proposes); a council member does here. One approval is not enough to run it.
  const id = await addProposal(1, `Bluvfi confidential treasury: sign ${hashHex}`, signProposal(DAO, hashHex));
  const first = await voteWithOutcome(1, id, "VoteApprove");
  assert.equal(mpcSignature(first as never), undefined, "nothing is signed before the threshold is met");
  assert.equal((await proposalById(id)).status, "InProgress");

  // The second approval executes it: the signer is asked, and its signature is in this vote's outcome.
  const second = await voteWithOutcome(2, id, "VoteApprove");
  const signature = mpcSignature(second as never);
  assert.ok(signature, "the council's executing vote carries the MPC signature");
  assert.equal(verifyMpcSignature(hashHex, signature, key), true, "it signs this hash under this DAO's key");
  assert.equal((await proposalById(id)).status, "Approved");
  await until("the proposal to settle", async () => (await proposalById(id)).status === "Approved");

  // A vote cast from a wallet is not seen by this app, so the signature is found from the chain index instead: the DAO's recent calls are read
  // and the one whose signature verifies for this hash under this DAO's key is the answer. The index can lag a few seconds behind the chain.
  const found = await until("the chain index to show the vote", async () => findMpcSignature(DAO, hashHex, key), 90_000);
  assert.equal(found, signature, "the index gives the same signature the vote carried");
  assert.equal(await findMpcSignature(DAO, createHash("sha256").update("a hash nobody signed").digest("hex"), key), undefined, "no signature for a hash the council never approved");

  // A signature is for one hash only, and one DAO's key is not another's.
  const other = createHash("sha256").update("another hash").digest("hex");
  assert.equal(verifyMpcSignature(other, signature, key), false);
  assert.equal(verifyMpcSignature(hashHex, signature, await daoDerivedKey("some-other-dao.sputnikv2.testnet")), false);
});
