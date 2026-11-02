/**
 * Builds the real testnet treasury the Layer 1 tests run against. Idempotent: rerun it and it skips what exists.
 *   npm run testnet:keys && npm run testnet:setup
 *
 * 1. Named testnet accounts for three council members, the agent and a relayer, created and funded (10 NEAR each) by
 *    NEAR's testnet account helper.
 * 2. A real Sputnik DAO from the testnet factory (sputnikv2.testnet): a 3-member council that executes on 2 votes, a
 *    Requestor role holding only the agent, proposal bond 0.
 * 3. The agent's account locked down to ONE function-call key (add_proposal on the DAO); its full-access key is deleted.
 * Writes .testnet/accounts.json. Everything here is throwaway and testnet only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, teraToGas, type KeyPairString } from "near-api-js";

const RPC = "https://test.rpc.fastnear.com";
const HELPER = "https://helper.nearprotocol.com/account";
const FACTORY = "sputnikv2.testnet";
const KEYS = ".testnet/keys.json";
const OUT = ".testnet/accounts.json";
const SUFFIX = "7f3k2";
const NAMES: Record<string, string> = {
  council1: "bluvfi-c1-7f3k2.testnet", // created earlier by hand with the same helper
  council2: `bluvfi-c2-${SUFFIX}.testnet`,
  council3: `bluvfi-c3-${SUFFIX}.testnet`,
  agent: `bluvfi-agent-${SUFFIX}.testnet`,
  relayer: `bluvfi-relayer-${SUFFIX}.testnet`,
};
const DAO_NAME = `bluvfi-${SUFFIX}`;
const DAO = `${DAO_NAME}.${FACTORY}`;

type Keys = Record<string, { account: string; secret: string; publicKey: string }>;
const keys = JSON.parse(readFileSync(KEYS, "utf8")) as Keys;
const provider = new JsonRpcProvider({ url: RPC });
const acct = (role: string) => new Account(NAMES[role], provider, keys[role].secret as KeyPairString);

async function exists(id: string) {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // 1. accounts
  for (const [role, name] of Object.entries(NAMES)) {
    if (await exists(name)) { console.log("exists ", name); continue; }
    const r = await fetch(HELPER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: name, newAccountPublicKey: keys[role].publicKey }) });
    if (!r.ok) throw new Error(`helper refused ${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    console.log("created", name);
  }
  for (const role of Object.keys(NAMES)) keys[role].account = NAMES[role];

  // 2. the DAO
  if (!(await exists(DAO))) {
    const policy = {
      roles: [
        { name: "council", kind: { Group: [NAMES.council1, NAMES.council2, NAMES.council3] }, permissions: ["*:Finalize", "*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"], vote_policy: {} },
        { name: "requestor", kind: { Group: [NAMES.agent] }, permissions: ["call:AddProposal", "transfer:AddProposal"], vote_policy: {} },
      ],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
      proposal_bond: "0",
      proposal_period: "604800000000000",
      bounty_bond: "1000000000000000000000000",
      bounty_forgiveness_period: "86400000000000",
    };
    const args = Buffer.from(JSON.stringify({ config: { name: DAO_NAME, purpose: "Bluvfi Business Layer 1 testnet treasury", metadata: "" }, policy })).toString("base64");
    await acct("council1").callFunction({ contractId: FACTORY, methodName: "create", args: { name: DAO_NAME, args }, gas: teraToGas(150), deposit: BigInt("6000000000000000000000000") });
    console.log("created DAO", DAO);
  } else console.log("exists ", DAO);

  // 3. the agent holds one function-call key and nothing else
  const agent = acct("agent");
  const scoped = (keys.agentScoped ??= (() => { const k = KeyPair.fromRandom("ed25519"); return { account: NAMES.agent, secret: k.toString(), publicKey: k.getPublicKey().toString() }; })());
  const list = await agent.getAccessKeyList();
  if (!list.keys.some((k) => k.public_key === scoped.publicKey)) {
    await agent.addFunctionCallAccessKey({ publicKey: scoped.publicKey, contractId: DAO, methodNames: ["add_proposal"], allowance: BigInt("500000000000000000000000") });
    console.log("added the scoped function-call key to", NAMES.agent);
  }
  const full = (await agent.getAccessKeyList()).keys.filter((k) => k.access_key.permission === "FullAccess");
  for (const k of full) {
    await agent.deleteKey(k.public_key);
    console.log("deleted the agent's full-access key", k.public_key.slice(0, 20) + "…");
  }

  writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  writeFileSync(OUT, JSON.stringify({ network: "testnet", dao: DAO, factory: FACTORY, suffix: SUFFIX, accounts: NAMES }, null, 2));
  console.log("\nDone. DAO:", DAO, "| details in", OUT);
}

if (!existsSync(KEYS)) throw new Error("Run npm run testnet:keys first");
main().catch((e) => { console.error(e); process.exit(1); });
