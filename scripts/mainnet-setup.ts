/**
 * The command-line version of the browser setup at /setup (lib/setup.ts). Builds a REAL mainnet treasury for live mode, the same shape the testnet suite uses (scripts/testnet-setup.ts):
 *   1. an agent account, created as a sub-account of your funding account;
 *   2. a Sputnik DAO from sputnik-dao.near (the factory Trezu's DAOs come from): your council executes on a majority,
 *      a Requestor role holds only the agent, and the proposal bond is 0 so the agent's key can propose;
 *   3. the agent locked down to ONE function-call key (add_proposal on the DAO); its full-access key is deleted;
 *   4. .env.local filled in (existing values are kept, apart from the custody lines this script owns).
 *
 * It spends real NEAR, so by default it only checks and prints the plan. Nothing is sent without --yes.
 *   npm run mainnet:setup -- --funder you.near --council you.near,partner.near --name yourteam
 *   MAINNET_FUNDER_KEY=ed25519:... npm run mainnet:setup -- --funder you.near --council you.near,partner.near --name yourteam --yes
 *
 * MAINNET_FUNDER_KEY is a full-access key of --funder. It is read from the environment only and never written to disk.
 * Rerunning is safe: each step is skipped if it is already done. Keys are kept in .mainnet/agent.json (git-ignored).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { daoPolicy, writeEnvFile } from "../lib/setup";

const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org";
const FACTORY = "sputnik-dao.near";
const KEYS = ".mainnet/agent.json";
const ENV = ".env.local";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const send = process.argv.includes("--yes");
const funder = arg("funder") ?? "";
const council = (arg("council") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const name = (arg("name") ?? "").toLowerCase();
const agentId = arg("agent") ?? `bluvfi-agent.${funder}`;
const daoDeposit = (arg("dao-deposit") ?? "6") as `${number}`;
const agentFunding = (arg("agent-funding") ?? "0.3") as `${number}`;
const DAO = `${name}.${FACTORY}`;

const provider = new JsonRpcProvider({ url: RPC });

async function exists(id: string) {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

/** The agent's two keys: a full-access key used once to install the scoped key, then deleted. Saved before any use. */
function agentKeys(): { full: string; scoped: string } {
  if (existsSync(KEYS)) return JSON.parse(readFileSync(KEYS, "utf8"));
  const k = { full: KeyPair.fromRandom("ed25519").toString(), scoped: KeyPair.fromRandom("ed25519").toString() };
  mkdirSync(".mainnet", { recursive: true });
  writeFileSync(KEYS, JSON.stringify(k, null, 2), { mode: 0o600 }); // readable by this user only, and deleted once setup is done
  return k;
}
const pub = (secret: string) => KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();


async function main() {
  const problems: string[] = [];
  if (!/^(?:[a-z0-9_-]+\.)*near$|^[0-9a-f]{64}$/.test(funder)) problems.push("--funder must be your mainnet account (name.near).");
  if (council.length < 2) problems.push("--council needs at least two accounts you control, comma-separated.");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) problems.push("--name must be lowercase letters, digits and dashes (the DAO becomes <name>.sputnik-dao.near).");
  if (council.includes(agentId)) problems.push("The agent cannot be on the council.");
  if (!(Number(daoDeposit) > 0) || !(Number(agentFunding) > 0)) problems.push("--dao-deposit and --agent-funding must be positive numbers of NEAR.");
  if (problems.length) throw new Error(problems.join("\n"));

  const [funderOk, councilOk, agentThere, daoThere] = await Promise.all([
    exists(funder), Promise.all(council.map(exists)), exists(agentId), exists(DAO),
  ]);
  if (!funderOk) throw new Error(`${funder} does not exist on mainnet.`);
  const missing = council.filter((_, i) => !councilOk[i]);
  if (missing.length) throw new Error(`These council accounts do not exist on mainnet: ${missing.join(", ")}`);

  const need = council.length;
  const votes = Math.floor(need / 2) + 1;
  console.log(`Plan (mainnet, real NEAR):
  1. agent account   ${agentId}  ${agentThere ? "exists, skipped" : `create, funded with ${agentFunding} NEAR from ${funder}`}
  2. DAO             ${DAO}  ${daoThere ? "exists, skipped" : `create from ${FACTORY} with ${daoDeposit} NEAR (it stays in the DAO's own account)`}
                     council ${council.join(", ")} (executes on ${votes} of ${need}), requestor ${agentId}, proposal bond 0
  3. agent key       one function-call key: add_proposal on ${DAO}, 0.25 NEAR gas allowance; then its full-access key is deleted
  4. ${ENV}      CUSTODY=sputnik, DAO_ACCOUNT, AGENT_ACCOUNT, AGENT_PRIVATE_KEY (+ a master key and signer tokens if missing)
  Roughly ${(daoThere ? 0 : Number(daoDeposit)) + (agentThere ? 0 : Number(agentFunding))} NEAR moves, plus well under 0.1 NEAR of gas.`);
  if (!send) {
    console.log("\nNothing was sent. Rerun with MAINNET_FUNDER_KEY set and --yes to do it.");
    return;
  }

  const funderKey = process.env.MAINNET_FUNDER_KEY ?? "";
  if (!/^(ed25519|secp256k1|ml-dsa-65):/.test(funderKey)) throw new Error("Set MAINNET_FUNDER_KEY to a full-access key of --funder.");
  const fund = new Account(funder, provider, funderKey as KeyPairString);
  const k = agentKeys(); // saved to disk before any transaction uses them

  // 1. the agent account
  if (!agentThere) {
    if (!agentId.endsWith(`.${funder}`)) throw new Error(`${agentId} does not exist and is not a sub-account of ${funder}; create it yourself or pass --agent bluvfi-agent.${funder}.`);
    await fund.createSubAccount({ accountOrPrefix: agentId.slice(0, -funder.length - 1), publicKey: pub(k.full), nearToTransfer: nearToYocto(agentFunding) });
    console.log("created", agentId);
  }

  // 2. the DAO
  if (!daoThere) {
    const policy = daoPolicy(council, agentId);
    const args = Buffer.from(JSON.stringify({ config: { name, purpose: "Bluvfi Business treasury", metadata: "" }, policy })).toString("base64");
    await fund.callFunction({ contractId: FACTORY, methodName: "create", args: { name, args }, gas: teraToGas(150), deposit: nearToYocto(daoDeposit) });
    console.log("created DAO", DAO);
  }

  // 3. the agent holds one function-call key and nothing else
  const agentFull = new Account(agentId, provider, k.full as KeyPairString);
  const keys = (await agentFull.getAccessKeyList()).keys;
  if (!keys.some((x) => x.public_key === pub(k.scoped))) {
    if (!keys.some((x) => x.public_key === pub(k.full))) throw new Error(`${agentId} does not hold the key in ${KEYS}, so this script cannot set it up. Use a new agent account.`);
    await agentFull.addFunctionCallAccessKey({ publicKey: pub(k.scoped), contractId: DAO, methodNames: ["add_proposal"], allowance: nearToYocto("0.25") });
    console.log("added the scoped function-call key");
  }
  for (const x of (await agentFull.getAccessKeyList()).keys.filter((y) => y.access_key.permission === "FullAccess")) {
    if (x.public_key !== pub(k.full)) throw new Error(`${agentId} has another full-access key (${x.public_key}). Delete it yourself; this script only deletes its own.`);
    await agentFull.deleteKey(x.public_key);
    console.log("deleted the agent's full-access key: it now holds only add_proposal");
  }

  // 4. .env.local
  const token = () => randomBytes(12).toString("hex");
  writeEnvFile(
    { CUSTODY: "sputnik", DAO_ACCOUNT: DAO, AGENT_ACCOUNT: agentId, AGENT_PRIVATE_KEY: k.scoped },
    { BLUVFI_MASTER_KEY: randomBytes(32).toString("hex"), BLUVFI_SIGNERS: `maya:${token()},devon:${token()}` },
  );
  // The full-access key is deleted onchain and the scoped key is in .env.local now, so the key file is not needed.
  unlinkSync(KEYS);
  console.log(`\nDone. ${ENV} is filled in (signer tokens are in it). Restart npm run dev, then open the Overview.`);
  if (/^ONECLICK_DRY=1/m.test(readFileSync(ENV, "utf8"))) console.log("Note: ONECLICK_DRY=1 is set in .env.local; remove it, or no proposal is ever filed.");
  console.log(`The DAO, in Trezu: https://trezu.app/${DAO}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
