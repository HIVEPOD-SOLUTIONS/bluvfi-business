import "./setup-confidential-flow";
import { AGENT_KEY } from "./setup-sputnik";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deserialize } from "borsh";
import { KeyPair, SCHEMA, baseDecode } from "near-api-js";
import { checkSettlement, processInvoice } from "../lib/agent";
import { nep413Hash, verifyMpcSignature } from "../lib/confidential";
import { advanceShield, confidentialSession, finishConfidentialLogin, loginStatus, shieldStatus, startConfidentialLogin, startShield } from "../lib/confidential-flow";
import { resetCustodyCache } from "../lib/custody";
import { resetState, state } from "../lib/store";
import { install, invoice, seed } from "./fakes";

/**
 * A confidential treasury end to end through the app's own code: log in with the council, pay, collect the council's signature
 * from the vote, submit to 1Click, settle. The outside world is one fake fetch that speaks the three protocols involved (NEAR RPC,
 * 1Click, FastNEAR's transaction index), shaped as the live APIs were observed to behave (tests/real/confidential.test.ts,
 * tests/testnet/confidential.test.ts). The MPC signer is a real ed25519 key, and every signature the fake receives is verified
 * for real against the exact NEP-413 hash, so a wrong hash, key or message fails.
 */
const DAO = "acme.sputnik-dao.near";
const MPC = KeyPair.fromRandom("ed25519"); // stands in for the key v1.signer derives for the DAO
const MPC_PUBLIC = MPC.getPublicKey().toString();
const AGENT_PERMISSION = { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } };
const POLICY = {
  proposal_bond: "0",
  proposal_period: "604800000000000",
  roles: [
    { name: "council", kind: { Group: ["maya.near", "devon.near"] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:AddProposal"] },
    { name: "agent", kind: { Group: ["acme-agent.near"] }, permissions: ["call:AddProposal", "transfer:AddProposal"] },
  ],
};

interface World {
  proposals: Map<number, { status: string; hashHex: string; description: string }>;
  nextId: number;
  indexLag: boolean;
  swapStatus: string;
  authBodies: { signedData: { payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string } }[];
  refreshCalls: string[];
  quoteHeaders: Record<string, string>[];
  submitted: { verified: boolean; intentHash?: string }[];
  rejectedSignatures: number;
  deposits: { amount: string; proposalId: number }[];
  shieldQuotes: Record<string, unknown>[];
}
let world: World;
const fresh = (): World => ({ proposals: new Map(), nextId: 50, indexLag: false, swapStatus: "PROCESSING", authBodies: [], refreshCalls: [], quoteHeaders: [], submitted: [], rejectedSignatures: 0, deposits: [], shieldQuotes: [] });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const viewResult = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });

/** What `v1.signer.sign` returns for an approved proposal: the MPC key's real ed25519 signature over the 32-byte hash. */
const mpcReceipt = (hashHex: string) => ({
  execution_outcome: { outcome: { executor_id: "v1.signer", status: { SuccessValue: Buffer.from(JSON.stringify({ scheme: "Ed25519", signature: Array.from(MPC.sign(Buffer.from(hashHex, "hex")).signature) })).toString("base64") } } },
});

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

  // ---- NEAR RPC
  if (url.startsWith("https://rpc.mainnet.near.org")) {
    const req = body as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
    if (req.method === "query" && req.params.request_type === "view_access_key_list")
      return ok(req.params.account_id === "acme-agent.near"
        ? { keys: [{ public_key: AGENT_KEY.getPublicKey().toString(), access_key: { nonce: 7, permission: AGENT_PERMISSION } }] }
        : { keys: [{ public_key: "ed25519:CouncilClassicalKey111", access_key: { nonce: 1, permission: "FullAccess" } }] });
    if (req.method === "query" && req.params.request_type === "view_access_key") return ok({ nonce: 7, permission: AGENT_PERMISSION, block_height: 1, block_hash: "11111111111111111111111111111111" });
    if (req.method === "query" && req.params.request_type === "call_function") {
      const method = req.params.method_name;
      const args = JSON.parse(Buffer.from(String(req.params.args_base64), "base64").toString() || "{}") as { id?: number };
      if (method === "get_policy") return ok(viewResult(POLICY));
      if (method === "current_salt") return ok(viewResult("252812b3"));
      if (method === "derived_public_key") return ok(viewResult(MPC_PUBLIC));
      if (method === "get_proposal") {
        const p = world.proposals.get(Number(args.id));
        return ok(viewResult({ id: args.id, status: p?.status ?? "InProgress", votes: {} }));
      }
    }
    if (req.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100 } });
    if (req.method === "send_tx" || req.method === "broadcast_tx_commit") {
      const signed = deserialize(SCHEMA.SignedTransaction, Buffer.from(String((req.params as { signed_tx_base64?: string }).signed_tx_base64 ?? ""), "base64")) as { transaction: { actions: { functionCall?: { args: Uint8Array } }[] } };
      const { proposal } = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall!.args).toString()) as { proposal: { description: string; kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } } } };
      const fc = proposal.kind.FunctionCall;
      if (fc.receiver_id !== "v1.signer") {
        // The only other proposal the agent files: depositing USDC into the DAO's own Intents balance.
        const call = JSON.parse(Buffer.from(fc.actions[0].args, "base64").toString()) as { receiver_id: string; amount: string; msg: string };
        assert.equal(fc.actions[0].method_name, "ft_transfer_call");
        assert.equal(call.receiver_id, "intents.near");
        assert.deepEqual(JSON.parse(call.msg), { receiver_id: DAO }, "deposited for the DAO's own account");
        const did = world.nextId++;
        world.proposals.set(did, { status: "InProgress", hashHex: "", description: proposal.description });
        world.deposits.push({ amount: call.amount, proposalId: did });
        return ok({ final_execution_status: "FINAL", status: { SuccessValue: Buffer.from(String(did)).toString("base64") }, transaction: { hash: "TxHash111" }, transaction_outcome: { id: "TxHash111", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } }, receipts_outcome: [] });
      }
      assert.equal(fc.receiver_id, "v1.signer", "the proposal asks the MPC signer, and nothing else");
      assert.equal(fc.actions.length, 1);
      assert.equal(fc.actions[0].method_name, "sign");
      const sign = JSON.parse(Buffer.from(fc.actions[0].args, "base64").toString()) as { request: { payload_v2: { Eddsa: string }; path: string; domain_id: number } };
      assert.deepEqual([sign.request.path, sign.request.domain_id], [DAO, 1]);
      const id = world.nextId++;
      world.proposals.set(id, { status: "InProgress", hashHex: sign.request.payload_v2.Eddsa, description: proposal.description });
      return ok({ final_execution_status: "FINAL", status: { SuccessValue: Buffer.from(String(id)).toString("base64") }, transaction: { hash: "TxHash111" }, transaction_outcome: { id: "TxHash111", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } }, receipts_outcome: [] });
    }
    return ok({});
  }

  // ---- FastNEAR's transaction index: the council's executing votes, as a wallet would have sent them
  if (url.startsWith("https://tx.main.fastnear.com")) {
    const approved = [...world.proposals.values()].filter((p) => p.status === "Approved" && !world.indexLag);
    if (url.endsWith("/v0/account")) return json({ account_txs: approved.map((_, i) => ({ transaction_hash: `vote-${i}`, is_receiver: true, is_function_call: true, is_success: true })) });
    if (url.endsWith("/v0/transactions")) {
      const wanted = (body.tx_hashes as string[]).map((h) => Number(h.replace("vote-", "")));
      return json({ transactions: wanted.map((i) => ({ execution_outcome: { outcome: { status: { SuccessValue: "" } } }, receipts: [mpcReceipt(approved[i].hashHex)] })) });
    }
  }

  // ---- 1Click
  if (url.startsWith("https://1click.chaindefuser.com")) {
    const path = url.replace("https://1click.chaindefuser.com", "").split("?")[0];
    const authed = (token: string) => headers.authorization === `Bearer ${token}`;
    if (path === "/v0/auth/authenticate") {
      const d = (body as World["authBodies"][number]).signedData;
      world.authBodies.push(body as World["authBodies"][number]);
      const hash = nep413Hash(d.payload.message, Buffer.from(d.payload.nonce, "base64"), d.payload.recipient).toString("hex");
      if (!verifyMpcSignature(hash, d.signature, MPC_PUBLIC) || d.public_key !== MPC_PUBLIC) return json({ message: "signature verification failed" }, 401);
      return json({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900, refreshExpiresIn: 604800 }, 201);
    }
    if (path === "/v0/auth/refresh") {
      world.refreshCalls.push(String(body.refreshToken));
      return body.refreshToken === "refresh-1" ? json({ accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 900, refreshExpiresIn: 604800 }, 201) : json({ message: "Invalid refresh token" }, 401);
    }
    // everything below needs the partner key and the treasury's own session
    if (headers["x-api-key"] !== "partner-key-for-tests") return json({ message: "Invalid token" }, 401);
    if (!(authed("access-1") || authed("access-2"))) return json({ message: "User authentication is required for confidential intent quotes" }, 401);
    if (path === "/v0/quote" && body.depositType === "INTENTS") {
      // Shielding: public Intents balance to confidential, 1:1.
      world.shieldQuotes.push(body);
      assert.equal(body.swapType, "EXACT_INPUT");
      assert.equal(body.recipientType, "CONFIDENTIAL_INTENTS");
      assert.equal(body.recipient, DAO);
      return json({ quote: { depositAddress: "5ade79fb".repeat(8), deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(), amountInFormatted: "2.0", amountOutFormatted: "2.0" } }, 201);
    }
    if (path === "/v0/quote") {
      world.quoteHeaders.push(headers);
      assert.equal(body.depositType, "CONFIDENTIAL_INTENTS");
      assert.equal(body.refundTo, DAO);
      assert.equal(body.recipientType, "DESTINATION_CHAIN");
      return json({ quote: { depositAddress: "c0ffee".repeat(10) + "abcd", deadline: new Date(Date.now() + 11 * 86_400_000).toISOString(), amountInFormatted: "1400.50", amountOutFormatted: "1240" } }, 201);
    }
    if (path === "/v0/generate-intent") {
      assert.equal(body.signerId, DAO);
      const nonce = Buffer.alloc(32, 7);
      const shield = String(body.depositAddress).startsWith("5ade79fb");
      const token = shield ? "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" : "imt:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
      const message = JSON.stringify({ deadline: "2026-12-01T00:00:00.000Z", intents: [{ intent: "transfer", receiver_id: body.depositAddress, tokens: { [token]: shield ? "2000000" : "1400500000" } }], signer_id: DAO });
      // A shield moves the public token, so it is addressed to intents.near; a payout moves the shielded one, addressed to intents.far.
      return json({ intent: { standard: "nep413", payload: { message, nonce: nonce.toString("base64"), recipient: shield ? "intents.near" : "intents.far" } }, correlationId: "c" }, 201);
    }
    if (path === "/v0/submit-intent") {
      const d = (body as { signedData: { payload: { message: string; nonce: string; recipient: string }; public_key: string; signature: string } }).signedData;
      const hash = nep413Hash(d.payload.message, Buffer.from(d.payload.nonce, "base64"), d.payload.recipient).toString("hex");
      const verified = verifyMpcSignature(hash, d.signature, MPC_PUBLIC) && d.public_key === MPC_PUBLIC;
      if (!verified) { world.rejectedSignatures++; return json({ message: "signature verification failed" }, 400); }
      world.submitted.push({ verified, intentHash: "INTENTHASH1" });
      return json({ intentHash: "INTENTHASH1", correlationId: "c" }, 201);
    }
    if (path === "/v0/status") return json({ status: world.swapStatus, swapDetails: { refundedAmountFormatted: "0" } });
  }
  throw new Error(`Unexpected request in the test world: ${url}`);
}

async function inWorld<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => fakeFetch(String(url), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

beforeEach(() => {
  world = fresh();
  resetCustodyCache();
  install();
  seed();
  resetState();
  seed();
  // Prior payment to the vendor, so the counterparty check passes and the invoice is clear to pay.
  state().payments.push({ status: "paid", createdAt: "2026-10-01T00:00:00.000Z", invoice: { payoutAddress: "northwind.near", amountUsd: 0 } } as never);
});

/** The council approves the login proposal, and the treasury logs in. */
async function logIn() {
  const { proposalId } = await startConfidentialLogin();
  world.proposals.get(proposalId)!.status = "Approved";
  return finishConfidentialLogin();
}

test("the council logs the treasury in: the proposal asks the MPC signer to sign the login, and the login is accepted only with that signature", async () => {
  await inWorld(async () => {
    assert.equal(loginStatus().state, "needs_login");
    const { proposalId } = await startConfidentialLogin();
    const login = state().confidential!.login!;
    // The proposal carries the NEP-413 hash of exactly the message and nonce that will be sent to 1Click.
    assert.equal(world.proposals.get(proposalId)!.hashHex, nep413Hash(login.message, Buffer.from(login.nonce, "base64"), "intents.near").toString("hex"));
    assert.equal(JSON.parse(login.message).intents.length, 0, "the login moves nothing");
    assert.match(world.proposals.get(proposalId)!.description, /moves nothing/);
    assert.equal(loginStatus().state, "waiting_for_council");

    assert.equal((await finishConfidentialLogin()).state, "waiting_for_council", "still open: nothing happens");
    world.proposals.get(proposalId)!.status = "Approved";
    world.indexLag = true;
    assert.equal((await finishConfidentialLogin()).state, "waiting_for_signature", "approved, but the vote is not on the index yet");
    assert.equal(world.authBodies.length, 0);
    world.indexLag = false;
    const done = await finishConfidentialLogin();
    assert.equal(done.state, "logged_in");
    assert.equal(world.authBodies.length, 1);
    assert.equal(world.authBodies[0].signedData.public_key, MPC_PUBLIC, "logged in as the DAO's derived key");
    assert.equal(state().confidential!.login, undefined);

    // The tokens are kept encrypted, never in the clear.
    assert.ok(!JSON.stringify(state().confidential).includes("access-1") && !JSON.stringify(state().confidential).includes("refresh-1"));
    assert.equal(await confidentialSession(), "access-1");
  });
});

test("a rejected login proposal leaves the treasury logged out and says to start again", async () => {
  await inWorld(async () => {
    const { proposalId } = await startConfidentialLogin();
    world.proposals.get(proposalId)!.status = "Rejected";
    const s = await finishConfidentialLogin();
    assert.equal(s.state, "needs_login");
    assert.match(s.detail, /was rejected/);
  });
});

test("the access token is refreshed on its own, and a week later the council has to log in again", async () => {
  await inWorld(async () => {
    await logIn();
    state().confidential!.accessExp = Date.now() - 1; // the fifteen minutes are up
    assert.equal(await confidentialSession(), "access-2");
    assert.deepEqual(world.refreshCalls, ["refresh-1"]);
    state().confidential!.accessExp = Date.now() - 1;
    state().confidential!.refreshExp = Date.now() - 1; // and the week
    await assert.rejects(confidentialSession(), /not logged in to Confidential Intents/);
  });
});

test("a payout is filed as a signing proposal, the council's signature is collected from the vote, and 1Click runs it to payment", async () => {
  await inWorld(async () => {
    // Without a login, nothing is paid and nothing is proposed.
    const early = await processInvoice(invoice({ invoiceNumber: "INV-EARLY" }));
    assert.notEqual(early.status, "proposed");
    assert.match(early.reason, /not logged in to Confidential Intents/);
    assert.equal(world.proposals.size, 0);

    await logIn();
    const p = await processInvoice(invoice({ invoiceNumber: "INV-CONF" }));
    assert.equal(p.status, "proposed", p.reason);
    assert.equal(p.quote?.confidential, true);
    assert.equal(world.quoteHeaders.length, 1);
    assert.equal(world.quoteHeaders[0].authorization, "Bearer access-1", "the treasury's own session");
    assert.equal(world.quoteHeaders[0]["x-api-key"], "partner-key-for-tests", "and the partner key");

    // The council is asked to sign the intent's hash, and is told nothing about who is paid.
    const c = p.custody!;
    const proposal = world.proposals.get(Number(c.ref))!;
    assert.equal(proposal.hashHex, c.confidential!.hashHex);
    assert.equal(proposal.hashHex, nep413Hash(c.confidential!.intent.payload.message, Buffer.from(c.confidential!.intent.payload.nonce, "base64"), "intents.far").toString("hex"));
    assert.ok(!proposal.description.includes("northwind") && !proposal.description.includes("1240"), "no payee and no amount in the public proposal");
    assert.match(proposal.description, /Hash To Sign/);

    // Votes still open: nothing to collect.
    assert.equal((await checkSettlement(p.id)).status, "proposed");
    assert.equal(world.submitted.length, 0);

    // Approved, but the vote is not on the index yet: it waits and tries again.
    proposal.status = "Approved";
    world.indexLag = true;
    const waiting = await checkSettlement(p.id);
    assert.equal(waiting.status, "proposed");
    assert.match(waiting.reason, /collecting the signature/);
    assert.equal(world.submitted.length, 0);

    // The vote shows: the signature is read and verified, the intent goes to 1Click.
    world.indexLag = false;
    const sent = await checkSettlement(p.id);
    assert.equal(sent.status, "ready_to_send", sent.reason);
    assert.deepEqual(world.submitted, [{ verified: true, intentHash: "INTENTHASH1" }]);
    assert.equal(world.rejectedSignatures, 0);
    assert.equal(sent.custody!.confidential!.intentHash, "INTENTHASH1");

    // Checked again, it is not submitted twice, and settles from 1Click's confidential status.
    assert.equal((await checkSettlement(p.id)).status, "ready_to_send");
    assert.equal(world.submitted.length, 1);
    world.swapStatus = "SUCCESS";
    const paid = await checkSettlement(p.id);
    assert.equal(paid.status, "paid");
  });
});

test("a payout that 1Click fails is cancelled and its invoice number is released", async () => {
  await inWorld(async () => {
    await logIn();
    const p = await processInvoice(invoice({ invoiceNumber: "INV-FAIL" }));
    world.proposals.get(Number(p.custody!.ref))!.status = "Approved";
    assert.equal((await checkSettlement(p.id)).status, "ready_to_send");
    world.swapStatus = "FAILED";
    const failed = await checkSettlement(p.id);
    assert.equal(failed.status, "cancelled");
    assert.deepEqual(state().vendors[0].paidInvoiceNumbers, []);
  });
});

test("a signature that does not match is never submitted: it is not on the index for this hash, so the payout waits", async () => {
  await inWorld(async () => {
    await logIn();
    const p = await processInvoice(invoice({ invoiceNumber: "INV-WRONG" }));
    const proposal = world.proposals.get(Number(p.custody!.ref))!;
    proposal.status = "Approved";
    proposal.hashHex = "00".repeat(32); // the council signed some other hash
    const after = await checkSettlement(p.id);
    assert.equal(after.status, "proposed");
    assert.equal(world.submitted.length, 0);
    assert.equal(world.rejectedSignatures, 0, "nothing was even sent to 1Click");
  });
});

test("the key a DAO is logged in as is the one the signer derives, and the agent's key cannot sign for it", () => {
  assert.equal(baseDecode(MPC_PUBLIC.replace("ed25519:", "")).length, 32);
  assert.notEqual(AGENT_KEY.getPublicKey().toString(), MPC_PUBLIC);
});

test("shielding the DAO's USDC takes two council approvals: a deposit, then a signed shield", async () => {
  await inWorld(async () => {
    await logIn();
    assert.equal(shieldStatus().stage, "none");
    await assert.rejects(startShield(0), /above zero/);

    // Step one: an ordinary payment proposal that deposits the USDC for the DAO's own account.
    const { proposalId } = await startShield(2);
    assert.equal(world.deposits.length, 1);
    assert.equal(world.deposits[0].amount, "2000000");
    assert.equal(shieldStatus().stage, "deposit");
    await assert.rejects(startShield(1), /already in progress/);
    assert.equal((await advanceShield()).stage, "deposit", "still open: nothing moves");
    assert.equal(world.shieldQuotes.length, 0);

    // Deposited: only now is the shield quoted, and the council is asked to sign it.
    world.proposals.get(proposalId)!.status = "Approved";
    const signing = await advanceShield();
    assert.equal(signing.stage, "sign");
    assert.equal(world.shieldQuotes.length, 1);
    const signProposalId = [...world.proposals.keys()].pop()!;
    const hash = world.proposals.get(signProposalId)!.hashHex;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.match(world.proposals.get(signProposalId)!.description, /Nothing leaves the DAO/);

    // Approved, the vote not on the index yet: waits. Then it shows, and the intent is submitted with a verified signature.
    world.proposals.get(signProposalId)!.status = "Approved";
    world.indexLag = true;
    assert.match((await advanceShield()).detail, /collecting the signature/);
    assert.equal(world.submitted.length, 0);
    world.indexLag = false;
    assert.equal((await advanceShield()).stage, "submitted");
    assert.deepEqual(world.submitted, [{ verified: true, intentHash: "INTENTHASH1" }]);

    // It completes when 1Click says so, and is not submitted twice.
    assert.equal((await advanceShield()).stage, "submitted");
    world.swapStatus = "SUCCESS";
    const done = await advanceShield();
    assert.equal(done.stage, "done");
    assert.equal(world.submitted.length, 1);
    // A finished shield does not block the next one.
    assert.ok(await startShield(1));
  });
});

test("a deposit the council rejects shields nothing, and a failed shield says the USDC is still the DAO's", async () => {
  await inWorld(async () => {
    await logIn();
    const { proposalId } = await startShield(2);
    world.proposals.get(proposalId)!.status = "Rejected";
    const rejected = await advanceShield();
    assert.equal(rejected.stage, "failed");
    assert.match(rejected.detail, /was rejected\. Nothing moved/);

    const { proposalId: second } = await startShield(2);
    world.proposals.get(second)!.status = "Approved";
    await advanceShield();
    const signId = [...world.proposals.keys()].pop()!;
    world.proposals.get(signId)!.status = "Approved";
    await advanceShield();
    world.swapStatus = "FAILED";
    const failed = await advanceShield();
    assert.equal(failed.stage, "failed");
    assert.match(failed.detail, /still in the DAO's Intents balance/);
  });
});
