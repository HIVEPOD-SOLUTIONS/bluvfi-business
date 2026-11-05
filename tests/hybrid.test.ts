import "./setup";
import { AGENT_KEY } from "./setup-hybrid";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deserialize } from "borsh";
import { SCHEMA } from "near-api-js";
import { processInvoice } from "../lib/agent";
import { NEAR_USDC_CONTRACT } from "../lib/chains";
import { checkCustody, hybridRoute, resetCustodyCache, topUpIfLow } from "../lib/custody";
import { install, invoice, seed, state } from "./fakes";

const DAO = "acme.sputnik-dao.near";
const WALLET = "acme-spend.near";
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
  resetCustodyCache();
  state().payments.push({ status: "paid", createdAt: "2026-10-01T00:00:00.000Z", invoice: { payoutAddress: "northwind.near", amountUsd: 0 } } as never);
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const viewResult = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });

interface World {
  walletUsdc: number;
  perTxRaw?: string;
  proposalStatus?: string;
  outlayerCalls: string[];
  /** The proposal kinds the agent filed on the DAO, decoded from the signed transactions. */
  proposals: { description: string; kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string }[] } } }[];
}

/** One fake for both custodians: the NEAR RPC (agent key, DAO, USDC balance, transactions) and the OutLayer API. */
async function withWorld(w: World, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api.outlayer.ai") {
      w.outlayerCalls.push(u.pathname);
      if (u.pathname === "/wallet/v1/policy") {
        return json({ controller: "acme.near", frozen: false, policy: "stored", rules: { limits: w.perTxRaw ? { per_transaction: { "*": w.perTxRaw }, daily: { "*": "15000000000" } } : { daily: { "*": "15000000000" } } } });
      }
      if (u.pathname === "/wallet/v1/storage-deposit") return json({ status: "success" });
      if (u.pathname === "/wallet/v1/call") return json({ request_id: "req-1", status: "success", tx_hash: "OLTX" });
      return json({ error: "not_found" }, 404);
    }
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    const p = req.params;
    if (req.method === "query" && p.request_type === "view_access_key_list") {
      const permission = { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } };
      return ok({ keys: [{ public_key: AGENT_KEY.getPublicKey().toString(), access_key: { nonce: 7, permission } }] });
    }
    if (req.method === "query" && p.request_type === "view_access_key") {
      return ok({ nonce: 7, permission: { FunctionCall: { receiver_id: DAO, method_names: ["add_proposal"], allowance: "250000000000000000000000" } }, block_height: 1, block_hash: "11111111111111111111111111111111" });
    }
    if (req.method === "query" && p.request_type === "call_function") {
      if (p.method_name === "get_policy") return ok(viewResult(POLICY));
      if (p.method_name === "get_proposal") return ok(viewResult({ id: 43, status: w.proposalStatus ?? "InProgress", kind: {}, votes: {}, description: "" }));
      if (p.method_name === "ft_balance_of" && p.account_id === NEAR_USDC_CONTRACT) {
        const who = JSON.parse(Buffer.from(String(p.args_base64), "base64").toString()).account_id;
        return ok(viewResult(who === WALLET ? String(Math.round(w.walletUsdc * 1e6)) : "0"));
      }
    }
    if (req.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100 } });
    if (req.method === "send_tx" || req.method === "broadcast_tx_commit") {
      const signed = deserialize(SCHEMA.SignedTransaction, Buffer.from(String((p as { signed_tx_base64: string }).signed_tx_base64), "base64")) as {
        transaction: { actions: { functionCall?: { args: Uint8Array } }[] };
      };
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall!.args).toString()) as { proposal: World["proposals"][number] };
      w.proposals.push(args.proposal);
      return ok({
        final_execution_status: "FINAL",
        status: { SuccessValue: Buffer.from(String(42 + w.proposals.length)).toString("base64") },
        transaction: { hash: "TxHash111" },
        transaction_outcome: { id: "TxHash111", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } },
        receipts_outcome: [],
      });
    }
    return ok({});
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const world = (over: Partial<World> = {}): World => ({ walletUsdc: 20_000, perTxRaw: "5000000000", outlayerCalls: [], proposals: [], ...over });
const ftTransfer = (k: World["proposals"][number]["kind"]) =>
  JSON.parse(Buffer.from(k.FunctionCall.actions.find((a) => a.method_name === "ft_transfer")!.args, "base64").toString()) as { receiver_id: string; amount: string };

test("hybrid: custody passes only when OutLayer caps each payment at the approval threshold", async () => {
  await withWorld(world({ perTxRaw: "10000000000" }), async () => {
    const c = await checkCustody();
    assert.equal(c.ok, false);
    assert.match(c.problems.join(" "), /allows \$10,000 per payment, above the \$5,000 approval threshold/);
  });
  resetCustodyCache();
  await withWorld(world({ perTxRaw: undefined }), async () => {
    assert.match((await checkCustody()).problems.join(" "), /no per-payment USDC limit/);
  });
  resetCustodyCache();
  await withWorld(world(), async () => {
    const c = await checkCustody();
    assert.equal(c.ok, true, c.problems.join(" "));
    assert.equal(c.mode, "hybrid");
    assert.ok(c.facts.some((f) => /^Routing: payments under \$5,000 are paid from the spending wallet/.test(f)));
    assert.ok(c.facts.some((f) => /holds \$20,000 USDC: the most that can leave without a council vote/.test(f)));
    assert.ok(c.facts.some((f) => f.startsWith("Vault (DAO): Agent key")));
    assert.ok(c.councilKill, "the DAO's onchain hard stop is still offered");
  });
});

test("hybrid: a routine payment is paid from the spending wallet, with no DAO proposal", async () => {
  const w = world();
  await withWorld(w, async () => {
    const p = await processInvoice(invoice({ invoiceNumber: "INV-H1" }));
    assert.equal(p.custody?.backend, "outlayer", p.reason);
    assert.match(p.custody!.route!, /paid from the spending wallet/);
    assert.match(p.reason, /paid from the spending wallet/);
    assert.ok(w.outlayerCalls.includes("/wallet/v1/call"));
    assert.equal(w.proposals.length, 0, "wallet at $20,000 is above its $15,000 low mark: no top-up");
  });
});

test("hybrid: payments at or over the approval threshold always go to the DAO council", async () => {
  await withWorld(world(), async () => {
    assert.equal((await hybridRoute(5_000)).backend, "sputnik");
    assert.equal((await hybridRoute(4_999)).backend, "outlayer");
  });
  await withWorld(world({ walletUsdc: Number.NaN }), async () => {
    // An unreadable balance never sends a payment to the wallet.
    assert.equal((await hybridRoute(100)).backend, "sputnik");
  });
});

test("hybrid: a payment the wallet cannot cover goes to the DAO, and the agent proposes a top-up", async () => {
  const w = world({ walletUsdc: 500 });
  await withWorld(w, async () => {
    const p = await processInvoice(invoice({ invoiceNumber: "INV-H2" }));
    assert.equal(p.custody?.backend, "sputnik", p.reason);
    assert.equal(p.status, "proposed");
    assert.match(p.custody!.route!, /holds \$500, less than \$1,240, so this goes to the DAO council/);
    assert.ok(!w.outlayerCalls.includes("/wallet/v1/call"));

    assert.equal(w.proposals.length, 2, "the payout, then the top-up");
    const top = w.proposals[1];
    assert.match(top.description, /Title: Top up the agent's spending wallet/);
    assert.equal(top.kind.FunctionCall.receiver_id, NEAR_USDC_CONTRACT);
    const t = ftTransfer(top.kind);
    assert.equal(t.receiver_id, WALLET);
    assert.equal(t.amount, String(29_500 * 1e6), "refills to twice the $15,000 daily limit");
    assert.equal(state().topUp?.proposalId, 44);
    assert.equal(state().topUp?.amountUsd, 29_500);
  });
});

test("hybrid: only one top-up is open at a time, and none while the kill switch is on", async () => {
  const w = world({ walletUsdc: 500 });
  await withWorld(w, async () => {
    assert.match((await topUpIfLow()).note, /Filed top-up proposal #43/);
    assert.match((await topUpIfLow()).note, /still waiting for council votes/);
    assert.equal(w.proposals.length, 1);

    w.proposalStatus = "Approved";
    w.walletUsdc = 30_000;
    assert.match((await topUpIfLow()).note, /at or above its \$15,000 low mark/);
    assert.equal(state().topUp?.status, "Approved");

    w.walletUsdc = 100;
    state().killSwitch = true;
    assert.match((await topUpIfLow()).note, /kill switch is on/);
    assert.equal(w.proposals.length, 1);
  });
});
