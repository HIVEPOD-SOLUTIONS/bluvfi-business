import { cfg, setTreasury } from "./business";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import { NEAR_RPC_URL, NEAR_SUFFIX, NETWORK, SIGNERS } from "./config";
import { resetCustodyCache } from "./custody";
import { decrypt, encrypt } from "./crypto";
import { dataKey } from "./store";
import { currentBiz, DEFAULT_BIZ } from "./tenant";

/**
 * Treasury setup from the browser (app/setup). The person's own NEAR wallet signs the two steps that spend their money,
 * so their key never reaches this server:
 *   1. `create_account` on the registrar (`near`), making the agent account with a key this server generated;
 *   2. `create` on the Sputnik factory, making the DAO: their council executes on a majority, a Requestor role holds
 *      only the agent, and the proposal bond is 0 so the agent's function-call key can propose.
 * Then this server, holding the agent's own full-access key, gives the agent ONE function-call key (add_proposal on the
 * DAO), deletes the full-access key, and writes the custody settings to .env.local.
 *
 * Until signers exist, every setup request needs a one-time setup code that only the person running the server can
 * read (printed in its terminal and saved in DIR/setup-code.txt), so a stranger who reaches the page cannot use it.
 */
export const FACTORY = NETWORK === "testnet" ? "sputnikv2.testnet" : "sputnik-dao.near";
/** The registrar account whose create_account makes `<name>.near` (or `.testnet`) for anyone who pays for it. */
export const REGISTRAR = NEAR_SUFFIX;
export const DAO_DEPOSIT_NEAR = "6";
export const AGENT_FUNDING_NEAR = "0.3";
export const AGENT_ALLOWANCE_NEAR = "0.25";
const DIR = process.env.BLUVFI_SETUP_DIR ?? (NETWORK === "testnet" ? join(".testnet", "setup") : ".mainnet");
const ENV_FILE = process.env.BLUVFI_ENV_FILE ?? join(process.cwd(), ".env.local");
/** The operator's own business keeps its setup files in DIR; every other business has its own folder, with the files encrypted. */
const dirFor = () => (currentBiz() === DEFAULT_BIZ ? DIR : join(DIR, currentBiz()));
const keysFile = () => join(dirFor(), "agent.json");
const planFile = () => join(dirFor(), "setup.json");
const CODE = join(DIR, "setup-code.txt");

export interface WalletTransaction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[];
}

export interface SetupPlan {
  network: "mainnet" | "testnet";
  funder: string;
  council: string[];
  name: string;
  dao: string;
  agent: string;
  /** Votes the council needs to execute a payout. */
  votes: number;
  steps: { label: string; done: boolean }[];
  /** What the person's wallet signs; empty when both accounts already exist. */
  transactions: WalletTransaction[];
  costNear: number;
  createdAt: string;
}

export interface SetupResult {
  dao: string;
  agent: string;
  done: string[];
  /** Signer tokens created because none were configured. Shown once, so they can sign in. */
  signers?: { name: string; token: string }[];
}

const provider = () => new JsonRpcProvider({ url: NEAR_RPC_URL });
const save = (file: string, v: unknown) => {
  mkdirSync(dirFor(), { recursive: true });
  const json = JSON.stringify(v, null, 2);
  writeFileSync(file, currentBiz() === DEFAULT_BIZ ? json : encrypt(json, dataKey()));
};
const load = <T,>(file: string): T | undefined => {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8");
  return JSON.parse(currentBiz() === DEFAULT_BIZ ? raw : decrypt(raw, dataKey())) as T;
};
const pub = (secret: string) => KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();

async function exists(id: string) {
  try {
    await provider().query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

async function view<T>(account: string, method: string, args: object = {}): Promise<T> {
  const r = (await provider().query({
    request_type: "call_function", finality: "final", account_id: account, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as unknown as { result: number[] };
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

/** The DAO's policy: the council votes (a majority executes), the agent may only propose, and the bond is 0. */
export function daoPolicy(council: string[], agent: string) {
  return {
    roles: [
      { name: "council", kind: { Group: council }, permissions: ["*:Finalize", "*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove"], vote_policy: {} },
      { name: "requestor", kind: { Group: [agent] }, permissions: ["call:AddProposal", "transfer:AddProposal"], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "1000000000000000000000000",
    bounty_forgiveness_period: "86400000000000",
  };
}

/** Sets keys in the env file, keeping every other line; `ifMissing` keys only when absent or empty. Returns what it added. */
export function writeEnvFile(set: Record<string, string>, ifMissing: Record<string, string> = {}): Record<string, string> {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const added: Record<string, string> = {};
  const put = (k: string, v: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  };
  for (const [k, v] of Object.entries(set)) put(k, v);
  for (const [k, v] of Object.entries(ifMissing)) {
    if (!lines.some((l) => new RegExp(`^${k}=.+`).test(l))) {
      put(k, v);
      added[k] = v;
    }
  }
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
  return added;
}

/** Is a treasury already configured? Setup refuses to run over one. */
export const isConfigured = () => cfg().DAO_CUSTODY && !!cfg().DAO_ACCOUNT;

export function setupStatus() {
  return { configured: isConfigured(), dao: cfg().DAO_ACCOUNT, network: NETWORK, needsCode: currentBiz() === DEFAULT_BIZ && SIGNERS.length === 0, pending: load<SetupPlan>(planFile()) };
}

/** The one-time code that guards setup while no signers exist. Made on first use and printed to the server's terminal. */
export function setupCode(): string {
  let code = existsSync(CODE) ? readFileSync(CODE, "utf8").trim() : "";
  if (!code) {
    code = randomBytes(6).toString("hex");
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CODE, code);
  }
  return code;
}

export function announceSetupCode() {
  if (currentBiz() !== DEFAULT_BIZ || SIGNERS.length || isConfigured()) return;
  console.log(`\n[bluvfi] Treasury setup code: ${setupCode()}  (enter it on /setup; also saved in ${CODE})\n`);
}

const ACCOUNT = NETWORK === "testnet" ? /^(?:[a-z0-9_-]+\.)+testnet$|^[0-9a-f]{64}$/ : /^(?:[a-z0-9_-]+\.)*near$|^[0-9a-f]{64}$/;

/** Checks the request against the chain and returns what the wallet must sign. Saves the plan and the agent's keys. */
export async function planSetup(input: { funder: string; council: string[]; name: string; agent?: string }): Promise<SetupPlan> {
  if (isConfigured()) throw new Error(`A treasury is already configured (${cfg().DAO_ACCOUNT}). Setup only runs before one exists.`);
  const funder = input.funder.trim().toLowerCase();
  const council = [...new Set(input.council.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  const name = input.name.trim().toLowerCase();
  const agent = (input.agent?.trim().toLowerCase() || `${name}-agent.${REGISTRAR}`);
  const problems: string[] = [];
  if (!ACCOUNT.test(funder)) problems.push(`Connect a ${NETWORK} wallet first.`);
  if (council.length < 2) problems.push("The council needs at least two accounts you control.");
  for (const c of council) if (!ACCOUNT.test(c)) problems.push(`"${c}" is not a ${NETWORK} account name.`);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) problems.push("The treasury name must be 2-41 lowercase letters, digits and dashes.");
  if (!new RegExp(`^[a-z0-9][a-z0-9_-]{1,58}\\.${REGISTRAR}$`).test(agent)) problems.push(`The agent account must be a new name ending in .${REGISTRAR}, such as ${name || "acme"}-agent.${REGISTRAR}.`);
  if (council.includes(agent)) problems.push("The agent cannot be on the council.");
  if (problems.length) throw new Error(problems.join(" "));

  const dao = `${name}.${FACTORY}`;
  const [funderOk, councilOk, agentThere, daoThere] = await Promise.all([exists(funder), Promise.all(council.map(exists)), exists(agent), exists(dao)]);
  if (!funderOk) throw new Error(`${funder} does not exist on ${NETWORK}.`);
  const missing = council.filter((_, i) => !councilOk[i]);
  if (missing.length) throw new Error(`These council accounts do not exist on ${NETWORK}: ${missing.join(", ")}.`);

  // The agent's keys: kept if they belong to this agent, otherwise new ones. Saved before the wallet signs anything.
  let keys = load<{ agent: string; full: string; scoped: string }>(keysFile());
  if (agentThere && keys?.agent !== agent) throw new Error(`${agent} already exists and this server does not hold its key. Pick a new agent name.`);
  if (!keys || keys.agent !== agent) {
    keys = { agent, full: KeyPair.fromRandom("ed25519").toString(), scoped: KeyPair.fromRandom("ed25519").toString() };
    save(keysFile(), keys);
  }
  if (daoThere) {
    // An existing DAO is only usable if it is the one this setup describes.
    const policy = await view<{ roles: { name: string; kind: unknown }[] }>(dao, "get_policy").catch(() => null);
    const hasAgent = !!policy?.roles.some((r) => typeof r.kind === "object" && r.kind && "Group" in r.kind && (r.kind as { Group: string[] }).Group.includes(agent));
    if (!hasAgent) throw new Error(`${dao} already exists and does not list ${agent}. Pick another treasury name.`);
  }

  const transactions: WalletTransaction[] = [];
  if (!agentThere) {
    transactions.push({
      receiverId: REGISTRAR,
      actions: [{ type: "FunctionCall", params: { methodName: "create_account", args: { new_account_id: agent, new_public_key: pub(keys.full) }, gas: "100000000000000", deposit: nearToYocto(AGENT_FUNDING_NEAR).toString() } }],
    });
  }
  if (!daoThere) {
    const args = Buffer.from(JSON.stringify({ config: { name, purpose: "Bluvfi Business treasury", metadata: "" }, policy: daoPolicy(council, agent) })).toString("base64");
    transactions.push({
      receiverId: FACTORY,
      actions: [{ type: "FunctionCall", params: { methodName: "create", args: { name, args }, gas: "150000000000000", deposit: nearToYocto(DAO_DEPOSIT_NEAR).toString() } }],
    });
  }
  const plan: SetupPlan = {
    network: NETWORK, funder, council, name, dao, agent,
    votes: Math.floor(council.length / 2) + 1,
    steps: [
      { label: `Agent account ${agent}, funded with ${AGENT_FUNDING_NEAR} NEAR`, done: agentThere },
      { label: `Treasury DAO ${dao}, with ${DAO_DEPOSIT_NEAR} NEAR that stays in the DAO`, done: daoThere },
      { label: `Agent locked to one add_proposal key, full-access key deleted`, done: false },
      { label: `Custody settings written to ${ENV_FILE}`, done: false },
    ],
    transactions,
    costNear: (agentThere ? 0 : Number(AGENT_FUNDING_NEAR)) + (daoThere ? 0 : Number(DAO_DEPOSIT_NEAR)),
    createdAt: new Date().toISOString(),
  };
  save(planFile(), plan);
  return plan;
}

/** After the wallet signed: checks both accounts on the chain, locks the agent down and writes the settings. */
export async function finishSetup(): Promise<SetupResult> {
  if (isConfigured()) throw new Error(`A treasury is already configured (${cfg().DAO_ACCOUNT}).`);
  const plan = load<SetupPlan>(planFile());
  const keys = load<{ agent: string; full: string; scoped: string }>(keysFile());
  if (!plan || !keys || keys.agent !== plan.agent) throw new Error("No setup in progress. Check the plan first.");
  if (!(await exists(plan.agent))) throw new Error(`${plan.agent} is not on the chain yet. Sign the transactions in your wallet, then finish.`);
  if (!(await exists(plan.dao))) throw new Error(`${plan.dao} is not on the chain yet. Sign the transactions in your wallet, then finish.`);
  const policy = await view<{ roles: { name: string; kind: unknown; permissions: string[] }[]; proposal_bond: string }>(plan.dao, "get_policy");
  const requestor = policy.roles.find((r) => typeof r.kind === "object" && r.kind && "Group" in r.kind && (r.kind as { Group: string[] }).Group.includes(plan.agent));
  if (!requestor || requestor.permissions.some((p) => /Vote/.test(p))) throw new Error(`${plan.dao} does not give ${plan.agent} the Requestor role this setup expects.`);

  const done: string[] = [];
  const agent = new Account(plan.agent, provider(), keys.full as KeyPairString);
  const list = async () => (await provider().query({ request_type: "view_access_key_list", finality: "final", account_id: plan.agent })) as unknown as { keys: { public_key: string; access_key: { permission: unknown } }[] };
  const before = (await list()).keys;
  if (!before.some((k) => k.public_key === pub(keys.scoped))) {
    if (!before.some((k) => k.public_key === pub(keys.full))) throw new Error(`${plan.agent} does not hold this server's key, so it cannot be set up here.`);
    await agent.addFunctionCallAccessKey({ publicKey: pub(keys.scoped), contractId: plan.dao, methodNames: ["add_proposal"], allowance: nearToYocto(AGENT_ALLOWANCE_NEAR) });
    done.push(`Gave ${plan.agent} one function-call key: add_proposal on ${plan.dao}.`);
  }
  for (const k of (await list()).keys.filter((x) => x.access_key.permission === "FullAccess")) {
    if (k.public_key !== pub(keys.full)) throw new Error(`${plan.agent} has a full-access key this server did not make (${k.public_key}). Delete it yourself, then finish again.`);
    await agent.deleteKey(k.public_key);
    done.push(`Deleted the agent's full-access key: it can now only propose payments.`);
  }

  if (currentBiz() !== DEFAULT_BIZ) {
    // A business that signed up keeps its treasury in its own record, with the agent's key encrypted, not in the operator's env file.
    setTreasury(currentBiz(), { custody: "sputnik", dao: plan.dao, agent: plan.agent, agentKey: keys.scoped, treasury: plan.dao });
    done.push("Saved the treasury settings to your business.");
    resetCustodyCache();
    return { dao: plan.dao, agent: plan.agent, done };
  }

  // A master key and signer tokens are only made if the app has none, in the file or in its real environment.
  const token = () => randomBytes(12).toString("hex");
  const fresh: Record<string, string> = {};
  if (!process.env.BLUVFI_MASTER_KEY) fresh.BLUVFI_MASTER_KEY = randomBytes(32).toString("hex");
  if (!process.env.BLUVFI_SIGNERS) fresh.BLUVFI_SIGNERS = `maya:${token()},devon:${token()}`;
  const added = writeEnvFile(
    { CUSTODY: "sputnik", DAO_ACCOUNT: plan.dao, AGENT_ACCOUNT: plan.agent, AGENT_PRIVATE_KEY: keys.scoped, ...(NETWORK === "testnet" ? { BLUVFI_NETWORK: "testnet" } : {}) },
    fresh,
  );
  done.push(`Wrote the custody settings to ${ENV_FILE}.`);
  resetCustodyCache();
  const signers = added.BLUVFI_SIGNERS ? added.BLUVFI_SIGNERS.split(",").map((s) => ({ name: s.split(":")[0], token: s.split(":")[1] })) : undefined;
  return { dao: plan.dao, agent: plan.agent, done, signers };
}
