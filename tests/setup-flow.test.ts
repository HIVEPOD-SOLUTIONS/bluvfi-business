import "./setup";
import { SETUP_DIR as dir } from "./setup-setupflow";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";
import { deserialize } from "borsh";
import { KeyPair, SCHEMA, type KeyPairString } from "near-api-js";
import { finishSetup, planSetup, setupCode, writeEnvFile } from "../lib/setup";

const view = (o: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(o))), logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });

/** A fake NEAR chain: which accounts exist, the DAO's policy, the agent's keys, and the transactions sent (applied to the keys). */
function chain(state: { accounts: Set<string>; policy?: unknown; agentKeys: { public_key: string; access_key: { nonce: number; permission: unknown } }[]; sent: string[] }) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    const err = (name: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name }, message: name } }), { headers: { "content-type": "application/json" } });
    const p = req.params;
    if (p.request_type === "view_account") return state.accounts.has(String(p.account_id)) ? ok({ amount: "1", code_hash: "11111111111111111111111111111111", block_height: 1, block_hash: "11111111111111111111111111111111" }) : err("UNKNOWN_ACCOUNT");
    if (p.request_type === "call_function" && p.method_name === "get_policy") return ok(view(state.policy));
    if (p.request_type === "view_access_key_list") return ok({ keys: state.agentKeys });
    if (p.request_type === "view_access_key") {
      const k = state.agentKeys.find((x) => x.public_key === p.public_key);
      return k ? ok({ nonce: 1, permission: k.access_key.permission, block_height: 1, block_hash: "11111111111111111111111111111111" }) : err("UNKNOWN_ACCESS_KEY");
    }
    if (req.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100 } });
    if (req.method === "send_tx" || req.method === "broadcast_tx_commit") {
      const tx = deserialize(SCHEMA.SignedTransaction, Buffer.from(String(p.signed_tx_base64), "base64")) as {
        transaction: { actions: { addKey?: { publicKey: { ed25519Key: { data: number[] } } }; deleteKey?: { publicKey: { ed25519Key: { data: number[] } } } }[] };
      };
      const b58 = encode;
      for (const a of tx.transaction.actions) {
        if (a.addKey) {
          state.sent.push("addKey");
          state.agentKeys.push({ public_key: b58(a.addKey.publicKey.ed25519Key.data), access_key: { nonce: 0, permission: { FunctionCall: {} } } });
        }
        if (a.deleteKey) {
          state.sent.push("deleteKey");
          const gone = b58(a.deleteKey.publicKey.ed25519Key.data);
          state.agentKeys = state.agentKeys.filter((k) => k.public_key !== gone);
        }
      }
      return ok({
        final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: "Tx1" },
        transaction_outcome: { id: "Tx1", outcome: { status: { SuccessReceiptId: "r" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "x" } },
        receipts_outcome: [],
      });
    }
    return ok({});
  };
}

// base58 for ed25519 public keys, matching how NEAR prints them.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encode(bytes: number[]) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let s = "";
  while (n > BigInt(0)) {
    s = ALPHABET[Number(n % BigInt(58))] + s;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return `ed25519:${s}`;
}

async function withChain(state: Parameters<typeof chain>[0], body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = chain(state) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

test("setup: refuses a bad request before touching the chain", async () => {
  await assert.rejects(planSetup({ funder: "you.near", council: ["you.near"], name: "Acme Treasury" }), /at least two accounts.*lowercase letters/);
  await assert.rejects(planSetup({ funder: "you.near", council: ["you.near", "bob.near"], name: "acme", agent: "you.near" }), /cannot be on the council/);
});

test("setup: the plan is two wallet calls, the agent's key is saved first, and the DAO lets the agent only propose", async () => {
  const state = { accounts: new Set(["you.near", "bob.near"]), agentKeys: [], sent: [] as string[] };
  await withChain(state, async () => {
    const plan = await planSetup({ funder: "you.near", council: ["you.near", "bob.near"], name: "acme" });
    assert.equal(plan.agent, "acme-agent.near");
    assert.equal(plan.dao, "acme.sputnik-dao.near");
    assert.equal(plan.votes, 2);
    assert.equal(plan.costNear, 6.3);

    const keys = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as { agent: string; full: string };
    const [registrar, factory] = plan.transactions;
    assert.equal(registrar.receiverId, "near");
    assert.equal(registrar.actions[0].params.methodName, "create_account");
    assert.deepEqual(registrar.actions[0].params.args, { new_account_id: "acme-agent.near", new_public_key: KeyPair.fromString(keys.full as KeyPairString).getPublicKey().toString() });
    assert.equal(registrar.actions[0].params.deposit, "300000000000000000000000");

    assert.equal(factory.receiverId, "sputnik-dao.near");
    const created = JSON.parse(Buffer.from((factory.actions[0].params.args as { args: string }).args, "base64").toString());
    assert.equal(created.policy.proposal_bond, "0");
    const requestor = created.policy.roles.find((r: { name: string }) => r.name === "requestor");
    assert.deepEqual(requestor.kind, { Group: ["acme-agent.near"] });
    assert.deepEqual(requestor.permissions, ["call:AddProposal", "transfer:AddProposal"]);
    assert.equal(state.sent.length, 0, "planning sends nothing");
  });
});

test("setup: finish locks the agent to one add_proposal key, deletes its full-access key and writes the settings", async () => {
  const keys = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as { full: string; scoped: string };
  const full = KeyPair.fromString(keys.full as KeyPairString).getPublicKey().toString();
  const { daoPolicy } = await import("../lib/setup");
  writeFileSync(process.env.BLUVFI_ENV_FILE!, "NEAR_AI_API_KEY=keep-me\n");
  const state = {
    accounts: new Set(["you.near", "bob.near", "acme-agent.near", "acme.sputnik-dao.near"]),
    policy: daoPolicy(["you.near", "bob.near"], "acme-agent.near"),
    agentKeys: [{ public_key: full, access_key: { nonce: 1, permission: "FullAccess" as unknown } }],
    sent: [] as string[],
  };
  await withChain(state, async () => {
    const r = await finishSetup();
    assert.deepEqual(state.sent, ["addKey", "deleteKey"]);
    assert.equal(state.agentKeys.length, 1, "only the scoped key is left");
    assert.equal(state.agentKeys[0].public_key, KeyPair.fromString(keys.scoped as KeyPairString).getPublicKey().toString());
    assert.equal(r.signers?.length, undefined, "signers already configured by the test setup are kept");
  });
  const env = readFileSync(process.env.BLUVFI_ENV_FILE!, "utf8");
  assert.match(env, /^NEAR_AI_API_KEY=keep-me$/m, "other settings are kept");
  assert.match(env, /^CUSTODY=sputnik$/m);
  assert.match(env, /^DAO_ACCOUNT=acme\.sputnik-dao\.near$/m);
  assert.match(env, /^AGENT_ACCOUNT=acme-agent\.near$/m);
  assert.ok(env.includes(`AGENT_PRIVATE_KEY=${keys.scoped}`));
});

test("setup: the env writer adds secrets only when missing, and the setup code is stable", () => {
  const f = process.env.BLUVFI_ENV_FILE!;
  writeFileSync(f, "BLUVFI_SIGNERS=maya:existing-token-12345\n");
  const added = writeEnvFile({ CUSTODY: "sputnik" }, { BLUVFI_SIGNERS: "maya:new", BLUVFI_MASTER_KEY: "ab" });
  assert.deepEqual(Object.keys(added), ["BLUVFI_MASTER_KEY"]);
  assert.match(readFileSync(f, "utf8"), /BLUVFI_SIGNERS=maya:existing-token-12345/);
  assert.equal(setupCode(), setupCode());
  assert.match(setupCode(), /^[0-9a-f]{12}$/);
});

test("setup: with no signers anywhere, finish makes signer tokens and a master key and returns the tokens once", async () => {
  const saved = { signers: process.env.BLUVFI_SIGNERS, master: process.env.BLUVFI_MASTER_KEY };
  delete process.env.BLUVFI_SIGNERS;
  delete process.env.BLUVFI_MASTER_KEY;
  writeFileSync(process.env.BLUVFI_ENV_FILE!, "");
  const { daoPolicy } = await import("../lib/setup");
  const state = {
    accounts: new Set(["you.near", "bob.near", "acme-agent.near", "acme.sputnik-dao.near"]),
    policy: daoPolicy(["you.near", "bob.near"], "acme-agent.near"),
    agentKeys: [] as { public_key: string; access_key: { nonce: number; permission: unknown } }[],
    sent: [] as string[],
  };
  const keys = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as { scoped: string };
  state.agentKeys.push({ public_key: KeyPair.fromString(keys.scoped as KeyPairString).getPublicKey().toString(), access_key: { nonce: 1, permission: { FunctionCall: {} } } });
  try {
    await withChain(state, async () => {
      const r = await finishSetup();
      assert.deepEqual(state.sent, [], "already locked down: nothing to send");
      assert.deepEqual(r.signers?.map((s) => s.name), ["maya", "devon"]);
      for (const s of r.signers!) assert.match(s.token, /^[0-9a-f]{24}$/);
    });
    const env = readFileSync(process.env.BLUVFI_ENV_FILE!, "utf8");
    assert.match(env, /^BLUVFI_MASTER_KEY=[0-9a-f]{64}$/m);
    assert.match(env, /^BLUVFI_SIGNERS=maya:[0-9a-f]{24},devon:[0-9a-f]{24}$/m);
  } finally {
    process.env.BLUVFI_SIGNERS = saved.signers;
    process.env.BLUVFI_MASTER_KEY = saved.master;
  }
});
