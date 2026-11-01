import "./setup";
import "./setup-sputnik";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { actions, buildDelegateAction, encodeSignedDelegate, KeyPair } from "near-api-js";
import { processInvoice } from "../lib/agent";
import { checkCustody, relayVote } from "../lib/custody";
import { install, invoice, seed, state } from "./fakes";

const DAO = "acme.sputnik-dao.near";
const POLICY = {
  proposal_bond: "0",
  proposal_period: "604800000000000",
  roles: [
    { name: "council", kind: { Group: ["maya.near", "devon.near"] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:AddProposal"] },
    { name: "agent", kind: { Group: ["acme-agent.near"] }, permissions: ["call:AddProposal", "transfer:AddProposal"] },
  ],
};

beforeEach(() => {
  install();
  seed();
  // Prior payment to the vendor, so the counterparty check passes and the invoice is clear to pay.
  state().payments.push({ status: "paid", createdAt: "2026-10-01T00:00:00.000Z", invoice: { payoutAddress: "northwind.near", amountUsd: 0 } } as never);
});

const viewResult = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });

/** A fake NEAR RPC: the access key view, the DAO's views, and transactions (recorded). */
function nearRpc(opts: { permission: unknown; sent: { method: string; params: unknown }[] }) {
  return async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    if (req.method === "query" && req.params.request_type === "view_access_key")
      return ok({ nonce: 7, permission: opts.permission, block_height: 1, block_hash: "11111111111111111111111111111111" });
    if (req.method === "query" && req.params.request_type === "call_function" && req.params.method_name === "get_policy") return ok(viewResult(POLICY));
    if (req.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100 } });
    if (req.method === "send_tx" || req.method === "broadcast_tx_commit") {
      opts.sent.push({ method: req.method, params: req.params });
      return ok({
        final_execution_status: "FINAL",
        status: { SuccessValue: Buffer.from("43").toString("base64") },
        transaction: { hash: "TxHash111" },
        transaction_outcome: { id: "TxHash111", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } },
        receipts_outcome: [],
      });
    }
    return ok({});
  };
}

async function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response>, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const scoped = { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } };

test("custody: a full-access agent key is refused, so nothing can be proposed", async () => {
  await withFetch(nearRpc({ permission: "FullAccess", sent: [] }), async () => {
    const c = await checkCustody();
    assert.equal(c.ok, false);
    assert.match(c.problems.join(" "), /FULL-ACCESS/);
    const p = await processInvoice(invoice({ invoiceNumber: "INV-FA" }));
    assert.equal(p.status, "blocked");
    assert.match(p.reason, /Custody check failed/);
  });
});

test("custody: a key scoped to the wrong method is refused", async () => {
  await withFetch(nearRpc({ permission: { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal", "act_proposal"], allowance: null } }, sent: [] }), async () => {
    const c = await checkCustody();
    assert.equal(c.ok, false);
    assert.match(c.problems.join(" "), /limited to add_proposal/);
  });
});

test("custody: with a scoped key the agent proposes storage_deposit + ft_transfer, with the evidence in the description", async () => {
  const sent: { method: string; params: unknown }[] = [];
  await withFetch(nearRpc({ permission: scoped, sent }), async () => {
    const c = await checkCustody();
    assert.equal(c.ok, true, c.problems.join(" "));
    assert.match(c.facts.join(" "), /function-call only, receiver acme\.sputnik-dao\.near, method add_proposal/);
    assert.match(c.facts.join(" "), /maya\.near, devon\.near/);
    const p = await processInvoice(invoice({ invoiceNumber: "INV-DAO" }));
    assert.equal(p.status, "proposed", p.reason);
    assert.equal(p.custody?.ref, "43");
    assert.equal(p.custody?.url, `https://trezu.app/${DAO}/requests/43`);
    const kind = p.custody!.kind as { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string; deposit: string }[] } };
    assert.deepEqual(kind.FunctionCall.actions.map((a) => a.method_name), ["storage_deposit", "ft_transfer"]);
    const transfer = JSON.parse(Buffer.from(kind.FunctionCall.actions[1].args, "base64").toString());
    assert.equal(transfer.receiver_id, "dep-INV-DAO");
    assert.equal(transfer.amount, "1240000000");
    assert.equal(kind.FunctionCall.actions[1].deposit, "1");
    assert.equal(sent.length, 1, "exactly one transaction: add_proposal");
  });
});

function vote(opts: { receiverId?: string; method?: string; deposit?: bigint; sender?: string; action?: string } = {}) {
  const key = KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: opts.sender ?? "maya.near",
    receiverId: opts.receiverId ?? DAO,
    actions: [actions.functionCall(opts.method ?? "act_proposal", { id: 43, action: opts.action ?? "VoteApprove", proposal: {} }, BigInt(300e12), opts.deposit ?? BigInt(0))],
    nonce: BigInt(8),
    maxBlockHeight: BigInt(200),
    publicKey: key.getPublicKey(),
  } as never);
  const sig = key.sign(new Uint8Array(32));
  return Buffer.from(encodeSignedDelegate({ delegateAction, signature: { ed25519Signature: { data: sig.signature } } } as never)).toString("base64");
}

test("relayer: only one act_proposal vote on our DAO, from a council member, with no deposit, is relayed", async () => {
  const sent: { method: string; params: unknown }[] = [];
  await withFetch(nearRpc({ permission: "FullAccess", sent }), async () => {
    await assert.rejects(relayVote(vote({ receiverId: "other.near" })), /Only votes on our DAO/);
    await assert.rejects(relayVote(vote({ method: "add_proposal" })), /single act_proposal/);
    await assert.rejects(relayVote(vote({ deposit: BigInt(1) })), /no deposit/);
    await assert.rejects(relayVote(vote({ action: "Finalize" })), /Only votes/);
    await assert.rejects(relayVote(vote({ sender: "stranger.near" })), /not on the DAO council/);
    assert.equal(sent.length, 0, "nothing was relayed");
    const ok = await relayVote(vote());
    assert.equal(ok.sender, "maya.near");
    assert.equal(sent.length, 1);
  });
});
