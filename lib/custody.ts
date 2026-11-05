import { cfg } from "./business";
import { currentBiz } from "./tenant";
import { deserialize } from "borsh";
import { Account, JsonRpcProvider, KeyPair, SCHEMA, teraToGas, type KeyPairString } from "near-api-js";
import { ASSET_ID, NEAR_USDC_CONTRACT } from "./chains";
import { APPROVAL_THRESHOLD_SIGNERS, DEMO, NEAR_RPC_URL, OUTLAYER_BASE, PUBLIC_BASE_URL, RELAYER_ACCOUNT, RELAYER_PRIVATE_KEY, SPENDING_WALLET_LOW_USD, SPENDING_WALLET_TARGET_USD, TREZU_APP_URL } from "./config";
import { canonical, sha256 } from "./crypto";
import { currentPolicy, state } from "./store";
import { REQUIRE_CUSTODIAN_LIMITS } from "./config";
import type { CustodyRecord, Payment, Quote, TopUp } from "./types";

/**
 * Custody without a contract of our own. The agent never holds a key that can move funds:
 *
 *  - sputnik: the treasury is a Sputnik DAO v2 (what Trezu runs). The agent's NEAR key is a function-call key
 *    allowed to call only `add_proposal` on the DAO, with the DAO's proposal bond at 0 (a function-call key can
 *    attach no deposit). It proposes `storage_deposit` + `ft_transfer` of USDC to the 1Click deposit address; the
 *    council's approving vote executes it. Votes can be sent gasless through the relayer below.
 *  - outlayer: an OutLayer agent wallet. The owner's policy (per-transaction and daily caps, allowlist, multisig
 *    above a threshold, freeze) is enforced inside Intel TDX; the agent holds only an API key.
 *  - hybrid: the DAO is the vault and an OutLayer wallet is a spending wallet with a small balance. Payments under
 *    the approval threshold are paid from the wallet, within OutLayer's limits; larger ones, or ones the wallet
 *    cannot cover, become DAO proposals. When the wallet runs low the agent proposes a top-up from the DAO. The
 *    wallet's balance is the most that can ever leave without a council vote.
 *
 * Either way the evidence hash of the payment record goes onchain with the payout, in the proposal description
 * or the ft_transfer memo.
 */

const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000"; // 0.00125 NEAR, USDC's storage_balance_bounds.min
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** Binds a payout to its record: what was paid, to whom, and the signed AI review and policy it passed. */
export function evidenceHash(p: Payment): string {
  return sha256(canonical({
    payment: p.id,
    invoice: p.invoice.invoiceNumber,
    vendor: p.invoice.vendorName,
    amountUsd: p.invoice.amountUsd,
    payTo: `${p.invoice.chain}:${p.invoice.payoutAddress}`,
    deposit: p.quote?.depositAddress ?? "",
    checks: p.checks.map((c) => `${c.id}:${c.verdict}`),
    aiSignature: p.verified.signature.signature,
    aiSigner: p.verified.signature.signingAddress,
    policy: p.verified.policyHash,
  }));
}

const rawUsdc = (q: Quote, amountUsd: number) => q.amountInRaw ?? BigInt(Math.ceil(Number(q.amountIn || amountUsd) * 1e6)).toString();

// ---------- NEAR RPC views ----------

async function rpc<T>(params: Record<string, unknown>): Promise<T> {
  const r = await fetch(NEAR_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bvb", method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const j = (await r.json()) as { result?: T & { result?: number[] }; error?: { cause?: { name?: string }; message?: string } };
  if (j.error || !j.result) throw new Error(j.error?.cause?.name ?? j.error?.message ?? `rpc ${r.status}`);
  return j.result;
}

export async function viewFn<T>(account: string, method: string, args: object = {}): Promise<T> {
  const res = await rpc<{ result?: number[]; error?: string }>({ request_type: "call_function", account_id: account, method_name: method, args_base64: b64(args) });
  // A view that panics (for example a proposal id the chain has not finalized yet) returns an error and no result.
  if (!res.result) throw new Error(`${method} on ${account} returned no result${res.error ? `: ${res.error}` : ""}`);
  return JSON.parse(Buffer.from(res.result).toString()) as T;
}

export const viewDao = <T,>(method: string, args: object = {}) => viewFn<T>(cfg().DAO_ACCOUNT, method, args);

const HOUR = 3_600_000;

/**
 * How long a payout's 1Click quote must stay valid. A DAO payout waits for council votes, which can take as long as the
 * DAO's proposal period, and 1Click's deposit address stops working at the deadline it reports (funds sent after that can be
 * lost), so the deadline asked for is the DAO's own proposal period plus a day (1Click adds a margin of its own). Anything else may wait on a person or an approver: a day.
 */
export async function payoutWindowMs(): Promise<number> {
  const dao = cfg().CUSTODY === "sputnik" || cfg().CUSTODY === "hybrid";
  if (!dao || DEMO) return 24 * HOUR;
  try {
    const period = Number(BigInt((await viewDao<{ proposal_period: string }>("get_policy")).proposal_period) / BigInt(1_000_000));
    return Math.min(Math.max(period, 24 * HOUR), 30 * 24 * HOUR) + 24 * HOUR;
  } catch {
    return 8 * 24 * HOUR; // the Sputnik default of seven days, plus one
  }
}

interface VotePolicy { weight_kind?: string; quorum?: string; threshold: [number, number] | string }
interface DaoPolicy {
  proposal_bond: string;
  proposal_period: string;
  roles: { name: string; kind: "Everyone" | { Group: string[] } | { Member: string }; permissions: string[]; vote_policy?: Record<string, VotePolicy> }[];
  default_vote_policy?: VotePolicy;
}

/** Votes a Sputnik proposal needs, given a vote policy and the number of role members (ratio: floor(n*num/den)+1). */
export function approvalsNeeded(vp: VotePolicy | undefined, members: number): number | undefined {
  if (!vp || members < 1) return undefined;
  const t = vp.threshold;
  return Math.max(Array.isArray(t) ? Math.floor((members * t[0]) / t[1]) + 1 : Number(t), Number(vp.quorum ?? 0)) || undefined;
}

type KeyPermission = "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };

/** The only key the agent account may have: a function-call key that can call add_proposal on the DAO and nothing else. */
const isProposeOnly = (perm: KeyPermission) =>
  perm !== "FullAccess" && perm.FunctionCall.receiver_id === cfg().DAO_ACCOUNT && perm.FunctionCall.method_names.length === 1 && perm.FunctionCall.method_names[0] === "add_proposal";

/**
 * ML-DSA (FIPS 204, lattice-based) keys are post-quantum; ed25519 and secp256k1 keys are not. nearcore writes a full
 * ML-DSA key as `ml-dsa-65:…`, and lists access keys (`view_access_key_list`) as `ml-dsa-65-hash:…`, the SHA3-256 of
 * the 1,952-byte key (core/crypto/src/signature.rs, KeyType and PublicKeyHandle). Both count.
 */
export const isPostQuantumKey = (publicKey: string) => /^ml-?dsa/i.test(publicKey);

/**
 * Who can move the money, by key type. A quantum computer that can break ed25519 could forge a signature from any
 * classical full-access key on a council account, and with it a vote. Reads up to 25 council accounts.
 */
async function postQuantumCheck(agentKey: string, council: string[], facts: string[], problems: string[]) {
  const required = !!currentPolicy().requirePostQuantumKeys;
  const flag = (msg: string) => (required ? problems : facts).push(required ? msg : `Post-quantum note: ${msg}`);
  if (agentKey && !isPostQuantumKey(agentKey)) flag(`the agent key is ${agentKey.split(":")[0]}, not ML-DSA. Use an ML-DSA-65 key (ml-dsa-65:…; NEAR supports them).`);
  if (RELAYER_ACCOUNT && /^(ed25519|ml-dsa-65):/.test(RELAYER_PRIVATE_KEY)) {
    const rk = KeyPair.fromString(RELAYER_PRIVATE_KEY as KeyPairString).getPublicKey().toString();
    if (!isPostQuantumKey(rk)) flag(`the relayer key is ${rk.split(":")[0]}, not ML-DSA.`);
  }
  const lists = await Promise.all(council.slice(0, 25).map(async (m) => {
    try {
      const { keys } = await rpc<{ keys: { public_key: string; access_key: { permission: KeyPermission } }[] }>({ request_type: "view_access_key_list", account_id: m });
      return { m, classical: (keys ?? []).filter((k) => k.access_key.permission === "FullAccess" && !isPostQuantumKey(k.public_key)).length };
    } catch {
      return { m, classical: -1 };
    }
  }));
  for (const { m, classical } of lists) {
    if (classical > 0) flag(`council member ${m} has ${classical} classical (non-ML-DSA) full-access key${classical === 1 ? "" : "s"}; a future quantum computer could forge its votes. Replace them with ML-DSA keys.`);
    if (classical < 0) flag(`could not read the keys of council member ${m}.`);
  }
  const ready = lists.filter((x) => x.classical === 0).length;
  facts.push(`Post-quantum: ${ready} of ${lists.length} council member${lists.length === 1 ? "" : "s"} hold only ML-DSA full-access keys; agent key ${agentKey && isPostQuantumKey(agentKey) ? "ML-DSA" : "classical"}. Policy ${required ? "requires" : "does not yet require"} post-quantum keys.`);
}

/** Permissions that let an account vote on proposals. The agent must hold none of them. */
const VOTING = /:(\*|VoteApprove|VoteReject|VoteRemove)$/;
interface DaoProposal { id: number; status: string; kind: unknown; votes: Record<string, string>; description: string }

// ---------- Is the agent's credential really scoped? ----------

export interface CustodyCheck {
  mode: string; ok: boolean; facts: string[]; problems: string[];
  /** The agent key's owner deletes it. */
  killCommand?: string;
  /** The council removes the agent from its DAO role: an onchain hard stop that needs no key held by the agent's owner. */
  councilKill?: string;
}

/** One cached check per business: a business must never be shown another's result. */
const checkCache = new Map<string, { at: number; c: CustodyCheck }>();

/** Test hook: forget the cached custody check. */
export const resetCustodyCache = () => { checkCache.delete(currentBiz()); };

/**
 * Proves, from the chain or the custodian, that the agent cannot move funds on its own. The app refuses to
 * submit payouts while this fails (for example with a full-access agent key or a DAO bond the key cannot pay).
 */
export async function checkCustody(): Promise<CustodyCheck> {
  const hit = checkCache.get(currentBiz());
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.c;
  const c = DEMO ? demoCheck()
    : cfg().CUSTODY === "sputnik" ? await checkSputnik()
    : cfg().CUSTODY === "outlayer" ? await checkOutlayer()
    : cfg().CUSTODY === "hybrid" ? await checkHybrid()
    : manualCheck();
  if (cfg().CONFIDENTIAL && !DEMO) {
    const { loginStatus } = await import("./confidential-flow");
    if (cfg().CUSTODY !== "sputnik") c.problems.push("A confidential treasury needs Sputnik custody.");
    const login = loginStatus();
    (login.state === "logged_in" ? c.facts : c.problems).push(`Confidential Intents: ${login.detail}${login.loggedInUntil ? ` Until ${login.loggedInUntil}.` : ""}`);
    c.ok = c.problems.length === 0;
  }
  if (c.ok) checkCache.set(currentBiz(), { at: Date.now(), c });
  return c;
}

const manualCheck = (): CustodyCheck => ({
  mode: "manual",
  ok: true,
  facts: ["No custody integration: the agent holds no key at all. A signer sends each payout from their own wallet."],
  problems: [],
});

const demoCheck = (): CustodyCheck => ({
  mode: "sputnik (demo)",
  ok: true,
  facts: [
    `Treasury: ${cfg().DAO_ACCOUNT} (simulated in demo mode).`,
    "Agent key: function-call only, receiver the DAO, method add_proposal, and the only key on the agent account (simulated).",
    "Proposal bond 0, so the scoped key can propose; council votes execute.",
  ],
  problems: [],
});

class SkipSingleKey extends Error {}

async function checkSputnik(): Promise<CustodyCheck> {
  const facts: string[] = [];
  const problems: string[] = [];
  let councilKill: string | undefined;
  let publicKey = "";
  try {
    publicKey = KeyPair.fromString(cfg().AGENT_PRIVATE_KEY as KeyPairString).getPublicKey().toString();
    // nearcore names ML-DSA access keys by their hash, not the full key, so an ML-DSA agent key is checked through
    // the key list below, which already requires every key on the account to be add_proposal-only.
    if (isPostQuantumKey(publicKey)) throw new SkipSingleKey();
    const key = await rpc<{ permission: KeyPermission }>({
      request_type: "view_access_key", account_id: cfg().AGENT_ACCOUNT, public_key: publicKey,
    });
    if (key.permission === "FullAccess") problems.push(`The agent key on ${cfg().AGENT_ACCOUNT} is a FULL-ACCESS key. Replace it with a function-call key for add_proposal on ${cfg().DAO_ACCOUNT}.`);
    else {
      const fc = key.permission.FunctionCall;
      if (fc.receiver_id !== cfg().DAO_ACCOUNT) problems.push(`The agent key may call ${fc.receiver_id}, not the DAO ${cfg().DAO_ACCOUNT}.`);
      if (fc.method_names.length !== 1 || fc.method_names[0] !== "add_proposal") problems.push(`The agent key may call [${fc.method_names.join(", ") || "any method"}]; it must be limited to add_proposal.`);
      if (!problems.length) facts.push(`Agent key ${publicKey.slice(0, 18)}… on ${cfg().AGENT_ACCOUNT}: function-call only, receiver ${cfg().DAO_ACCOUNT}, method add_proposal${fc.allowance ? `, gas allowance ${(Number(BigInt(fc.allowance) / BigInt(1e18)) / 1e6).toFixed(3)} NEAR` : ""}. It cannot transfer, add keys or vote.`);
      if (fc.allowance && BigInt(fc.allowance) < BigInt(1e22)) problems.push("The agent key's gas allowance is almost used up; when it runs out the agent is locked out until the owner adds a new key.");
    }
  } catch (e) {
    if (e instanceof SkipSingleKey) facts.push(`Agent key is ML-DSA-65 (post-quantum); it is checked with the account's key list.`);
    else problems.push(`Could not read the agent key (${(e as Error).message}).`);
  }
  // "Holds only" the scoped key: every key on the agent account must be one. Another key, above all a full-access
  // one, could transfer the account's NEAR, add keys or deploy code, so whoever holds it could act as the agent.
  try {
    const { keys } = await rpc<{ keys: { public_key: string; access_key: { permission: KeyPermission } }[] }>({ request_type: "view_access_key_list", account_id: cfg().AGENT_ACCOUNT });
    if (!Array.isArray(keys) || !keys.length) throw new Error("no keys found");
    const others = keys.filter((k) => !isProposeOnly(k.access_key.permission));
    for (const k of others) {
      const perm = k.access_key.permission;
      problems.push(perm === "FullAccess"
        ? `${cfg().AGENT_ACCOUNT} also has a FULL-ACCESS key ${k.public_key.slice(0, 18)}…: whoever holds it can transfer from the account, add keys or deploy code. Delete it (near account delete-keys ${cfg().AGENT_ACCOUNT} public-keys ${k.public_key}) so the account holds only its add_proposal key.`
        : `${cfg().AGENT_ACCOUNT} also has key ${k.public_key.slice(0, 18)}…, which may call ${perm.FunctionCall.receiver_id} [${perm.FunctionCall.method_names.join(", ") || "any method"}]. Every key on the agent account must be limited to add_proposal on ${cfg().DAO_ACCOUNT}.`);
    }
    if (isPostQuantumKey(publicKey)) {
      const low = keys.some((k) => k.access_key.permission !== "FullAccess" && !!k.access_key.permission.FunctionCall.allowance && BigInt(k.access_key.permission.FunctionCall.allowance) < BigInt(1e22));
      if (low) problems.push("An agent key's gas allowance is almost used up; when it runs out the agent is locked out until it is replaced.");
    }
    if (!others.length) {
      facts.push(`All ${keys.length} key${keys.length === 1 ? "" : "s"} on ${cfg().AGENT_ACCOUNT} can only call add_proposal on ${cfg().DAO_ACCOUNT}: no one, the agent included, can transfer from the account, add keys, deploy code or vote with it. With no full-access key left, the account cannot add a key itself, so if it runs out of gas allowance or NEAR, create a new agent account and have the council swap it into the agent's role.`);
    }
  } catch (e) {
    problems.push(`Could not list the keys on ${cfg().AGENT_ACCOUNT} (${(e as Error).message}).`);
  }
  try {
    const policy = await viewDao<DaoPolicy>("get_policy");
    if (policy.proposal_bond !== "0") problems.push(`The DAO's proposal bond is ${policy.proposal_bond} yocto. A function-call key cannot attach a deposit, so set the bond to 0 (a ChangePolicyUpdateParameters proposal).`);
    else facts.push("DAO proposal bond is 0, so the scoped key can propose.");
    const agentRoles = policy.roles.filter((r) => r.kind === "Everyone" || ("Group" in r.kind && r.kind.Group.includes(cfg().AGENT_ACCOUNT)));
    const canPropose = agentRoles.some((r) => r.permissions.some((p) => /^(\*|call|transfer):(\*|AddProposal)$/.test(p)));
    if (!canPropose) problems.push(`${cfg().AGENT_ACCOUNT} has no DAO role allowed to add call proposals.`);
    const council = policy.roles.filter((r) => r.permissions.some((p) => /:(\*|VoteApprove)$/.test(p)) && typeof r.kind === "object" && "Group" in r.kind);
    const members = [...new Set(council.flatMap((r) => (r.kind as { Group: string[] }).Group))];
    facts.push(`Council (can approve): ${members.join(", ") || "none found"}.`);

    // Separation of duties, read from the DAO: the agent may propose and nothing else. Voting rights through a role
    // would let it approve its own proposals the day its key is replaced.
    for (const r of agentRoles) {
      const vote = r.permissions.find((p) => VOTING.test(p));
      if (vote) problems.push(`${cfg().AGENT_ACCOUNT} holds voting rights through the DAO role "${r.name}" (${vote}). The agent should only be able to add proposals.`);
    }
    if (!problems.some((x) => x.includes("voting rights"))) facts.push("The agent holds no voting rights in the DAO: it can propose a payout but never approve one, and it cannot change the DAO's policy.");
    const wider = [...new Set(agentRoles.flatMap((r) => r.permissions).filter((p) => /:AddProposal$/.test(p) && !/^(call|transfer):/.test(p)))];
    if (wider.length) facts.push(`Note: the agent may also propose ${wider.join(", ")}. Those still need council votes; for least privilege give its role only call:AddProposal and transfer:AddProposal (Trezu's Requestor).`);

    // The relayer's key sits on this server too. It must not be a council member, or the server could vote.
    if (RELAYER_ACCOUNT) {
      const relayerVotes = policy.roles.some((r) => typeof r.kind === "object" && "Group" in r.kind && r.kind.Group.includes(RELAYER_ACCOUNT) && r.permissions.some((p) => VOTING.test(p)));
      if (relayerVotes) problems.push(`The relayer ${RELAYER_ACCOUNT} holds voting rights in the DAO. Its key is on this server, so use an account that is not on the council.`);
      // Relaying needs a full-access key (it submits Delegate actions to any council member), so the relayer's balance is
      // exactly what a leaked key could take. Keep only gas money there.
      try {
        const acct = await rpc<{ amount: string }>({ request_type: "view_account", account_id: RELAYER_ACCOUNT });
        const near = Number(BigInt(acct.amount) / BigInt(1e18)) / 1e6;
        const max = Number(process.env.RELAYER_MAX_NEAR ?? 5);
        if (near > max) facts.push(`Warning: the relayer ${RELAYER_ACCOUNT} holds ${near.toFixed(2)} NEAR. Its full-access key is on this server, so keep it to gas money (under ${max} NEAR, RELAYER_MAX_NEAR).`);
        else facts.push(`The relayer ${RELAYER_ACCOUNT} holds ${near.toFixed(2)} NEAR, within its ${max} NEAR gas budget: the most its server-held key could lose.`);
      } catch {
        /* balance unknown: the voting-rights check above still ran */
      }
    }

    // The approval threshold the chain applies to a payout (a FunctionCall proposal).
    const first = council[0];
    const need = approvalsNeeded(first?.vote_policy?.call ?? policy.default_vote_policy, members.length);
    if (need !== undefined && members.length) {
      facts.push(need === 1 && members.length > 1
        ? `Note: the DAO executes a payout on ${need} of ${members.length} council approvals, so any single council member can approve one. Raise the threshold in Trezu for a real multisig.`
        : `The DAO executes a payout on ${need} of ${members.length} council approvals, enforced onchain.`);
    }

    await postQuantumCheck(publicKey, members, facts, problems);

    // Onchain hard stop: the council removes the agent from the role that lets it propose.
    const held = policy.roles.filter((r) => typeof r.kind === "object" && "Group" in r.kind && r.kind.Group.includes(cfg().AGENT_ACCOUNT));
    if (held.length) {
      councilKill = held.map((r) => {
        const rest = (r.kind as { Group: string[] }).Group.filter((a) => a !== cfg().AGENT_ACCOUNT);
        const kind = rest.length
          ? { ChangePolicyAddOrUpdateRole: { role: { name: r.name, kind: { Group: rest }, permissions: r.permissions, vote_policy: r.vote_policy ?? {} } } }
          : { ChangePolicyRemoveRole: { role: r.name } };
        const description = `Bluvfi Business kill switch: remove ${cfg().AGENT_ACCOUNT} from the "${r.name}" role`;
        return `near contract call-function as-transaction ${cfg().DAO_ACCOUNT} add_proposal json-args '${JSON.stringify({ proposal: { description, kind } })}' prepaid-gas '100 Tgas' attached-deposit '${policy.proposal_bond} yoctoNEAR' network-config mainnet sign-with-keychain send`;
      }).join(String.fromCharCode(10));
    }
  } catch (e) {
    problems.push(`Could not read the DAO policy of ${cfg().DAO_ACCOUNT} (${(e as Error).message}).`);
  }
  return {
    mode: "sputnik",
    ok: problems.length === 0,
    facts,
    problems,
    councilKill,
    killCommand: publicKey ? `near account delete-keys ${cfg().AGENT_ACCOUNT} public-keys ${publicKey} network-config mainnet sign-with-keychain send` : undefined,
  };
}

async function outlayer<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${OUTLAYER_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg().OUTLAYER_API_KEY}`,
      "content-type": "application/json",
      ...(init.idempotencyKey ? { "X-Idempotency-Key": init.idempotencyKey } : {}),
    },
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

const usdText = (n: number) => `$${n.toLocaleString("en-US")}`;

async function checkOutlayer(): Promise<CustodyCheck & { perPaymentUsd?: number }> {
  const facts: string[] = [];
  const problems: string[] = [];
  let perPaymentUsd: number | undefined;
  try {
    const { status, body: p } = await outlayer<{
      controller?: string; frozen?: boolean; policy?: string;
      rules?: { limits?: { per_transaction?: Record<string, string>; daily?: Record<string, string> }; addresses?: { mode: string; list: string[] } };
      approval?: { threshold?: number | { required: number }; approvers?: unknown[] };
    }>("/wallet/v1/policy");
    if (status !== 200) throw new Error(`status ${status}`);
    if (p.policy !== "stored") problems.push("This OutLayer wallet has no policy, so it is unrestricted. Set limits and approvers in the OutLayer dashboard first.");
    if (p.frozen) facts.push("The wallet is FROZEN by its owner: nothing can be sent.");
    facts.push(`OutLayer wallet controlled by ${p.controller ?? "unknown"}; the agent holds only an API key, keys stay in Intel TDX.`);
    const lim = p.rules?.limits;
    if (lim?.per_transaction || lim?.daily) facts.push(`Limits enforced by OutLayer: per transaction ${JSON.stringify(lim.per_transaction ?? {})}, daily ${JSON.stringify(lim.daily ?? {})}.`);
    // Is the app's own limit backed by the custodian? OutLayer reads limits per token ("*", "native" or a token contract).
    // The docs do not state units for token amounts, so USDC is read as base units (6 decimals).
    const pol = currentPolicy();
    const sync = (label: string, theirs: string | undefined, ours: number) => {
      if (theirs === undefined) {
        const msg = `OutLayer sets no ${label} limit for USDC, so the app's ${usdText(ours)} ${label} limit is enforced by this app only.`;
        if (REQUIRE_CUSTODIAN_LIMITS) problems.push(`${msg} REQUIRE_CUSTODIAN_LIMITS is on: set a ${label} limit in the OutLayer dashboard.`);
        else facts.push(msg);
      } else if (/^\d+$/.test(theirs)) {
        const n = Number(BigInt(theirs)) / 1e6;
        if (label === "per-payment") perPaymentUsd = n;
        if (n <= ours) facts.push(`Limit sync: OutLayer allows ${usdText(n)} per ${label === "daily" ? "day" : "payment"}, within the app's ${usdText(ours)}. The custodian enforces it too.`);
        else {
          const msg = `Limit sync: OutLayer allows ${usdText(n)} per ${label === "daily" ? "day" : "payment"}, above the app's ${usdText(ours)}. Lower it in the OutLayer dashboard so the custodian backs the app's limit.`;
          if (REQUIRE_CUSTODIAN_LIMITS) problems.push(`${msg} REQUIRE_CUSTODIAN_LIMITS is on, so payouts are refused until it is lowered.`);
          else facts.push(msg);
        }
      }
    };
    sync("per-payment", lim?.per_transaction?.[NEAR_USDC_CONTRACT] ?? lim?.per_transaction?.["*"], pol.perPaymentLimitUsd);
    sync("daily", lim?.daily?.[NEAR_USDC_CONTRACT] ?? lim?.daily?.["*"], pol.dailyLimitUsd);
    const t = p.approval?.threshold;
    if (t) facts.push(`Multisig: ${typeof t === "number" ? t : t.required} approver(s) above the threshold.`);
  } catch (e) {
    problems.push(`Could not read the OutLayer policy (${(e as Error).message}).`);
  }
  return { mode: "outlayer", ok: problems.length === 0, facts, problems, perPaymentUsd };
}

/**
 * Hybrid custody passes only if both custodians pass and OutLayer caps each payment at the approval threshold or
 * less. Then a payment too large for the wallet that this app routes there by mistake (or by compromise) is
 * refused by OutLayer, so a large payment can only leave through a council vote.
 */
async function checkHybrid(): Promise<CustodyCheck> {
  const [dao, wallet] = await Promise.all([checkSputnik(), checkOutlayer()]);
  const facts = [...dao.facts.map((f) => `Vault (DAO): ${f}`), ...wallet.facts.map((f) => `Spending wallet (OutLayer): ${f}`)];
  const problems = [...dao.problems.map((f) => `Vault (DAO): ${f}`), ...wallet.problems.map((f) => `Spending wallet (OutLayer): ${f}`)];
  const t = currentPolicy().approvalThresholdUsd;
  if (wallet.perPaymentUsd === undefined) {
    problems.push(`Spending wallet (OutLayer): no per-payment USDC limit is set. In hybrid custody OutLayer must cap each payment at the ${usdText(t)} approval threshold or less, so larger payments can only go through a council vote.`);
  } else if (wallet.perPaymentUsd > t) {
    problems.push(`Spending wallet (OutLayer): it allows ${usdText(wallet.perPaymentUsd)} per payment, above the ${usdText(t)} approval threshold. Lower it in the OutLayer dashboard so larger payments can only go through a council vote.`);
  } else {
    facts.push(`Routing: payments under ${usdText(t)} are paid from the spending wallet. OutLayer refuses any over ${usdText(wallet.perPaymentUsd)}, so larger payments can only leave through the DAO's council vote.`);
  }
  try {
    const bal = await spendingWalletUsdc();
    const { low, target } = spendingWalletBand();
    facts.push(`The spending wallet ${cfg().OUTLAYER_WALLET_ACCOUNT} holds ${usdText(bal)} USDC: the most that can leave without a council vote. Below ${usdText(low)} the agent asks the DAO for a top-up to ${usdText(target)}.`);
  } catch (e) {
    problems.push(`Could not read the spending wallet's USDC balance on ${cfg().OUTLAYER_WALLET_ACCOUNT || "(OUTLAYER_WALLET_ACCOUNT not set)"} (${(e as Error).message}).`);
  }
  facts.push("To stop the spending wallet at once, freeze it in the OutLayer dashboard; the council keeps control of the vault.");
  return { mode: "hybrid", ok: problems.length === 0, facts, problems, killCommand: dao.killCommand, councilKill: dao.councilKill };
}

// ---------- Hybrid: the spending wallet ----------

/** USDC held by the OutLayer spending wallet, read from the chain. */
export async function spendingWalletUsdc(): Promise<number> {
  if (!cfg().OUTLAYER_WALLET_ACCOUNT) throw new Error("OUTLAYER_WALLET_ACCOUNT is not set");
  return Number(BigInt(await viewFn<string>(NEAR_USDC_CONTRACT, "ft_balance_of", { account_id: cfg().OUTLAYER_WALLET_ACCOUNT }))) / 1e6;
}

/** Below `low` the agent asks the DAO to refill the wallet to `target`. Defaults: the daily limit, and twice it. */
export function spendingWalletBand() {
  const daily = currentPolicy().dailyLimitUsd;
  const low = SPENDING_WALLET_LOW_USD ?? daily;
  return { low, target: Math.max(SPENDING_WALLET_TARGET_USD ?? daily * 2, low) };
}

/** Where a payment goes in hybrid custody. Anything the wallet cannot be shown to cover goes to the council. */
export async function hybridRoute(amountUsd: number): Promise<{ backend: "sputnik" | "outlayer"; why: string }> {
  const t = currentPolicy().approvalThresholdUsd;
  if (amountUsd >= t) return { backend: "sputnik", why: `${usdText(amountUsd)} is at or over the ${usdText(t)} approval threshold, so it goes to the DAO council.` };
  const bal = await spendingWalletUsdc().catch(() => undefined);
  if (bal === undefined) return { backend: "sputnik", why: "The spending wallet's balance could not be read, so this goes to the DAO council." };
  if (bal < amountUsd) return { backend: "sputnik", why: `The spending wallet holds ${usdText(bal)}, less than ${usdText(amountUsd)}, so this goes to the DAO council.` };
  return { backend: "outlayer", why: `Under the ${usdText(t)} approval threshold, so it is paid from the spending wallet, within OutLayer's limits.` };
}

/**
 * Hybrid custody: when the spending wallet is below its low mark, the agent files one DAO proposal (with its
 * add_proposal key) to refill it to the target. The council still votes on it, and only one is open at a time.
 */
export async function topUpIfLow(): Promise<{ topUp?: TopUp; note: string }> {
  if (cfg().CUSTODY !== "hybrid" || DEMO) return { note: "Top-ups are only used with hybrid custody." };
  const s = state();
  if (s.killSwitch) return { topUp: s.topUp, note: "The kill switch is on, so no top-up is requested." };
  if (s.topUp?.status === "InProgress") {
    s.topUp.status = (await viewDao<DaoProposal>("get_proposal", { id: s.topUp.proposalId })).status;
    if (s.topUp.status === "InProgress") return { topUp: s.topUp, note: `Top-up proposal #${s.topUp.proposalId} is still waiting for council votes.` };
  }
  const bal = await spendingWalletUsdc();
  const { low, target } = spendingWalletBand();
  if (bal >= low) return { topUp: s.topUp, note: `The spending wallet holds ${usdText(bal)}, at or above its ${usdText(low)} low mark.` };
  const check = await checkCustody();
  if (!check.ok) throw new Error(`Custody check failed: ${check.problems.join(" ")}`);
  const amountUsd = Math.ceil(target - bal);
  const kind = {
    FunctionCall: {
      receiver_id: NEAR_USDC_CONTRACT,
      actions: [
        { method_name: "storage_deposit", args: b64({ account_id: cfg().OUTLAYER_WALLET_ACCOUNT, registration_only: true }), deposit: STORAGE_DEPOSIT_YOCTO, gas: "10000000000000" },
        { method_name: "ft_transfer", args: b64({ receiver_id: cfg().OUTLAYER_WALLET_ACCOUNT, amount: String(amountUsd * 1e6), memo: "bluvfi:top-up" }), deposit: "1", gas: "20000000000000" },
      ],
    },
  };
  const description = trezuDescription({
    proposal_action: "payment-transfer",
    title: "Top up the agent's spending wallet",
    notes: `Filed by the Bluvfi Business agent. The OutLayer spending wallet holds ${usdText(bal)}, under its ${usdText(low)} low mark; this refills it to ${usdText(target)}. Payments under the ${usdText(currentPolicy().approvalThresholdUsd)} approval threshold are paid from it, within OutLayer's limits.`,
    url: PUBLIC_BASE_URL,
    recipient: cfg().OUTLAYER_WALLET_ACCOUNT,
    destinationNetwork: ASSET_ID["near:USDC"],
  });
  const id = await addDaoProposal(kind, description);
  s.topUp = { proposalId: id, amountUsd, requestedAt: new Date().toISOString(), status: "InProgress", url: `${TREZU_APP_URL}/${cfg().DAO_ACCOUNT}/requests/${id}` };
  return { topUp: s.topUp, note: `Filed top-up proposal #${id} for ${usdText(amountUsd)}. The council must approve it.` };
}

// ---------- Submit a payout ----------

/** Hand an approved payment to the custodian. Throws if the custodian refuses (e.g. an OutLayer policy limit). */
export async function submitPayout(p: Payment): Promise<CustodyRecord> {
  if (!p.quote) throw new Error("No quote to pay");
  const check = await checkCustody();
  if (!check.ok) throw new Error(`Custody check failed: ${check.problems.join(" ")}`);
  const evidence = evidenceHash(p);
  const amount = rawUsdc(p.quote, p.invoice.amountUsd);
  const memo = `bluvfi:${evidence.slice(0, 32)}`;
  if (cfg().CONFIDENTIAL) return submitConfidential(p, evidence);
  if (cfg().CUSTODY === "hybrid") {
    const route = await hybridRoute(p.invoice.amountUsd);
    const rec = route.backend === "outlayer" ? await submitOutlayer(p, amount, memo, evidence) : await submitSputnik(p, amount, memo, evidence);
    rec.route = route.why;
    await topUpIfLow().catch(() => undefined); // best effort: the payout is already with its custodian
    return rec;
  }
  return cfg().CUSTODY === "outlayer" ? submitOutlayer(p, amount, memo, evidence) : submitSputnik(p, amount, memo, evidence);
}

function proposalFor(p: Payment, amount: string, memo: string, evidence: string) {
  const dep = p.quote!.depositAddress;
  const kind = {
    FunctionCall: {
      receiver_id: NEAR_USDC_CONTRACT,
      actions: [
        { method_name: "storage_deposit", args: b64({ account_id: dep, registration_only: true }), deposit: STORAGE_DEPOSIT_YOCTO, gas: "10000000000000" },
        { method_name: "ft_transfer", args: b64({ receiver_id: dep, amount, memo }), deposit: "1", gas: "20000000000000" },
      ],
    },
  };
  // A confidential payment keeps who and why out of the public proposal. Signers see them in the app, and the
  // evidence hash binds this payout to the encrypted record. The USDC amount to the deposit address stays visible onchain.
  const priv = p.confidentiality === "advanced";
  const description = trezuDescription({
    proposal_action: "payment-transfer",
    title: priv ? `Confidential payment ${p.id}` : `Invoice ${p.invoice.invoiceNumber}: ${p.invoice.vendorName}`,
    notes: priv
      ? "Proposed by the Bluvfi Business agent. Confidential payment: the vendor, invoice and payee are kept out of this public proposal. Signers see them in Bluvfi Business; the evidence hash below binds this payout to the encrypted record. Every policy and fraud check passed."
      : `Proposed by the Bluvfi Business agent. ${p.invoice.amountUsd} USD in ${p.invoice.asset} on ${p.invoice.chain}. AI recommends ${p.ai.decision} (risk ${p.ai.riskScore}/100); every policy and fraud check passed.`,
    url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/payments/${p.id}` : "",
    recipient: priv ? "" : p.invoice.payoutAddress,
    destinationNetwork: priv ? "" : ASSET_ID[`${p.invoice.chain}:${p.invoice.asset}`] ?? "",
    depositAddress: dep,
    // Funds sent to the deposit address after it stops working can be lost: the council should not approve after this.
    depositValidUntil: p.quote!.timeWhenInactive ?? p.quote!.deadline ?? "",
    signature: p.quote!.signature ?? "",
    // Ours, beyond what Trezu displays: the record this payout is bound to, and the signed AI review behind it.
    evidence,
    ai_signer: p.verified.signature.signingAddress,
    ai_signature: p.verified.signature.signature,
    policy: `v${p.verified.policyVersion}:${p.verified.policyHash}`,
  });
  return { kind, description };
}

/**
 * Trezu's proposal description format (nt-fe/lib/utils.ts encodeToMarkdown): `* Readable Key: value` lines joined
 * by " <br>". With `proposal_action: payment-transfer` Trezu (and NEAR Business, built the same way) shows the
 * proposal as a Payment Request to `recipient` on `destinationNetwork`, routed through the 1Click `depositAddress`.
 */
export function trezuDescription(data: Record<string, string>): string {
  const readable = (k: string) => k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase());
  return Object.entries(data)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `* ${readable(k)}: ${v.replace(/<br>/gi, " ")}`)
    .join(" <br>");
}

/** The agent files a proposal with its scoped key (add_proposal on the DAO, no deposit). Returns the DAO's proposal id. */
export async function addDaoProposal(kind: unknown, description: string): Promise<number> {
  if (DEMO) return demoDao().propose(kind as never, description);
  const agent = new Account(cfg().AGENT_ACCOUNT, new JsonRpcProvider({ url: NEAR_RPC_URL }), cfg().AGENT_PRIVATE_KEY as KeyPairString);
  return Number(await agent.callFunction({ contractId: cfg().DAO_ACCOUNT, methodName: "add_proposal", args: { proposal: { description, kind } }, gas: teraToGas(50), deposit: BigInt(0) }));
}

/**
 * A confidential treasury's payout: the agent files a proposal that asks NEAR's MPC signer to sign the transfer intent, and the council
 * approves it. The public proposal shows a hash and the evidence hash, not who is paid, which chain or how much.
 */
async function submitConfidential(p: Payment, evidence: string): Promise<CustodyRecord> {
  const flow = await import("./confidential-flow");
  const { intent, hashHex } = await flow.prepareIntent(p.quote!.depositAddress);
  const kind = (await import("./confidential")).signProposal(cfg().DAO_ACCOUNT, hashHex);
  const description = trezuDescription({
    proposal_action: "custom",
    title: `Confidential payment ${p.id}`,
    notes: "Proposed by the Bluvfi Business agent. Approving this has NEAR's MPC signer sign a confidential transfer from the treasury's shielded balance, which 1Click then pays out. The payee and amount are not shown here; signers see them in Bluvfi Business, and the evidence hash binds this payment to its encrypted record.",
    url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/payments/${p.id}` : "",
    hash_to_sign: hashHex,
    deposit_valid_until: p.quote!.timeWhenInactive ?? p.quote!.deadline ?? "",
    evidence,
    ai_signer: p.verified.signature.signingAddress,
    ai_signature: p.verified.signature.signature,
    policy: `v${p.verified.policyVersion}:${p.verified.policyHash}`,
  });
  const id = await addDaoProposal(kind, description);
  return {
    backend: "sputnik",
    ref: String(id),
    url: `${TREZU_APP_URL}/${cfg().DAO_ACCOUNT}/requests/${id}`,
    evidenceHash: evidence,
    submittedAt: new Date().toISOString(),
    state: "pending",
    detail: `Proposal #${id} asks the MPC signer to sign this confidential payout, and is waiting for the council's votes.`,
    kind,
    confidential: { intent, hashHex, depositAddress: p.quote!.depositAddress },
  };
}

async function submitSputnik(p: Payment, amount: string, memo: string, evidence: string): Promise<CustodyRecord> {
  const { kind, description } = proposalFor(p, amount, memo, evidence);
  const id = await addDaoProposal(kind, description);
  return {
    backend: "sputnik",
    ref: String(id),
    url: `${TREZU_APP_URL}/${cfg().DAO_ACCOUNT}/requests/${id}`,
    evidenceHash: evidence,
    submittedAt: new Date().toISOString(),
    state: "pending",
    detail: `Proposal #${id} on ${cfg().DAO_ACCOUNT}, waiting for the council's votes.`,
    kind,
  };
}

interface OutlayerResult { request_id?: string; status?: string; tx_hash?: string; approval_id?: string; required?: number; approved?: number; error?: string; message?: string; result?: { reason?: string } }

async function submitOutlayer(p: Payment, amount: string, memo: string, evidence: string): Promise<CustodyRecord> {
  const dep = p.quote!.depositAddress;
  const reg = await outlayer<OutlayerResult>("/wallet/v1/storage-deposit", { method: "POST", body: JSON.stringify({ token: NEAR_USDC_CONTRACT, account_id: dep }) });
  if (reg.status >= 400) throw new Error(`OutLayer refused the storage deposit: ${reg.body.message ?? reg.body.error ?? reg.status}`);
  const { status, body } = await outlayer<OutlayerResult>("/wallet/v1/call", {
    method: "POST",
    idempotencyKey: `bluvfi-${p.id}`,
    body: JSON.stringify({ receiver_id: NEAR_USDC_CONTRACT, method_name: "ft_transfer", args: { receiver_id: dep, amount, memo }, gas: "30000000000000", deposit: "1" }),
  });
  // A policy refusal (limits, allowlist, frozen) comes back synchronously as 403. That is the TEE-enforced policy working.
  if (status === 403) throw new Error(`OutLayer policy refused the payout (${body.error}): ${body.message ?? ""}`);
  if (status >= 400 || !body.request_id) throw new Error(`OutLayer call failed (${status}): ${body.message ?? body.error ?? "no request id"}`);
  const rec: CustodyRecord = {
    backend: "outlayer", ref: body.request_id, evidenceHash: evidence, submittedAt: new Date().toISOString(),
    state: "pending", detail: "", approvalId: body.approval_id, txHash: body.tx_hash,
    url: body.approval_id ? "https://app.outlayer.ai/wallet/approvals" : undefined,
  };
  return applyOutlayerStatus(rec, body);
}

function applyOutlayerStatus(rec: CustodyRecord, b: OutlayerResult): CustodyRecord {
  const s = b.status ?? "";
  rec.txHash = b.tx_hash ?? rec.txHash;
  if (s === "success") Object.assign(rec, { state: "executed", detail: `OutLayer sent the USDC (tx ${rec.txHash ?? "?"}).` });
  else if (s === "rejected") Object.assign(rec, { state: "rejected", detail: "The OutLayer approvers rejected this payout." });
  else if (s === "failed" || s === "needs_review") Object.assign(rec, { state: "failed", detail: `OutLayer could not execute it (${b.result?.reason ?? s}).` });
  else if (s === "pending_approval") Object.assign(rec, { state: "pending", detail: `Waiting for OutLayer approvers (${b.approved ?? 0} of ${b.required ?? "?"}).` });
  else Object.assign(rec, { state: "pending", detail: `OutLayer status: ${s || "processing"}.` });
  return rec;
}

// ---------- Follow a submitted payout ----------

export async function refreshPayout(rec: CustodyRecord): Promise<CustodyRecord> {
  if (rec.backend === "outlayer") {
    const { body } = await outlayer<OutlayerResult>(`/wallet/v1/requests/${encodeURIComponent(rec.ref)}`);
    return applyOutlayerStatus(rec, body);
  }
  const prop: DaoProposal = DEMO ? demoDao().get(Number(rec.ref)) : await viewDao<DaoProposal>("get_proposal", { id: Number(rec.ref) });
  rec.votes = prop.votes;
  const n = Object.keys(prop.votes ?? {}).length;
  if (prop.status === "Approved") Object.assign(rec, { state: "executed", detail: `Proposal #${rec.ref} approved and executed: the DAO sent the USDC to the NEAR Intents deposit address.` });
  else if (prop.status === "Rejected" || prop.status === "Removed" || prop.status === "Expired") Object.assign(rec, { state: "rejected", detail: `Proposal #${rec.ref} was ${prop.status.toLowerCase()}. Nothing left the treasury.` });
  else if (prop.status === "Failed") Object.assign(rec, { state: "failed", detail: `Proposal #${rec.ref} was approved but the transfer failed; the funds are still in the DAO.` });
  else Object.assign(rec, { state: "pending", detail: `Proposal #${rec.ref} is open, ${n} vote${n === 1 ? "" : "s"} so far.` });
  if (rec.confidential && rec.state === "executed") {
    // The council approved: the MPC signer signed. Read the signature from the vote and hand the intent to 1Click.
    try {
      await (await import("./confidential-flow")).completeConfidentialPayout(rec);
      rec.detail = `Proposal #${rec.ref} approved: the MPC signer signed the confidential transfer and 1Click has it (intent ${rec.confidential.intentHash}).`;
    } catch (e) {
      Object.assign(rec, { state: "pending", detail: `Proposal #${rec.ref} is approved; collecting the signature and submitting it to 1Click (${(e as Error).message}). This is retried each time the payment is checked.` });
    }
  }
  return rec;
}

// ---------- Gasless council votes (NEP-366) ----------

export const relayerEnabled = () => !DEMO && cfg().DAO_CUSTODY && !!RELAYER_ACCOUNT && /^(ed25519|ml-dsa-65):/.test(RELAYER_PRIVATE_KEY);

interface DecodedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: { functionCall?: { methodName: string; args: number[] | Uint8Array; gas: bigint; deposit: bigint } }[];
  };
}

/**
 * Relay a council member's vote. The vote is a SignedDelegate made in their browser with their own key; the
 * relayer only pays the gas. It relays nothing but one `act_proposal` on our DAO, with no deposit, from a
 * council member, so it cannot be used to spend the relayer's NEAR on anything else.
 */
export async function relayVote(signedDelegateBase64: string): Promise<{ txHash: string; sender: string }> {
  if (!relayerEnabled()) throw new Error("The relayer is not configured (RELAYER_ACCOUNT, RELAYER_PRIVATE_KEY).");
  const decoded = deserialize(SCHEMA.SignedDelegate, Buffer.from(signedDelegateBase64, "base64")) as unknown as DecodedDelegate;
  const da = decoded.delegateAction;
  if (da.receiverId !== cfg().DAO_ACCOUNT) throw new Error("Only votes on our DAO are relayed");
  const fc = da.actions.length === 1 ? da.actions[0].functionCall : undefined;
  if (!fc || fc.methodName !== "act_proposal") throw new Error("Only a single act_proposal call is relayed");
  if (BigInt(fc.deposit) !== BigInt(0)) throw new Error("Votes carry no deposit");
  const args = JSON.parse(Buffer.from(Uint8Array.from(fc.args)).toString()) as { action?: string };
  if (!["VoteApprove", "VoteReject", "VoteRemove"].includes(String(args.action))) throw new Error("Only votes are relayed");
  const policy = await viewDao<DaoPolicy>("get_policy");
  // Only roles that can vote count as the council: the agent's Requestor role must never get a vote relayed.
  const council = policy.roles.filter((r) => r.permissions.some((p) => VOTING.test(p))).flatMap((r) => (typeof r.kind === "object" && "Group" in r.kind ? r.kind.Group : []));
  if (!council.includes(da.senderId)) throw new Error(`${da.senderId} is not on the DAO council`);
  const relayer = new Account(RELAYER_ACCOUNT, new JsonRpcProvider({ url: NEAR_RPC_URL }), RELAYER_PRIVATE_KEY as KeyPairString);
  const out = await relayer.relayMetaTransaction(decoded as never);
  return { txHash: String((out as { transaction?: { hash?: string } }).transaction?.hash ?? ""), sender: da.senderId };
}

// ---------- Demo mode: a simulated DAO with the same rules ----------

/** In demo mode the DAO lives in the app state: proposals open, council votes, approval at the signer threshold. */
export function demoDao() {
  const s = state();
  const dao = (s.demoDao ??= { lastId: 41, proposals: {} });
  return {
    propose(kind: unknown, description: string) {
      const id = ++dao.lastId;
      dao.proposals[id] = { id, status: "InProgress", kind, votes: {}, description };
      return id;
    },
    get(id: number): DaoProposal {
      const p = dao.proposals[id];
      if (!p) throw new Error(`No proposal #${id}`);
      return p;
    },
    vote(id: number, member: string, action: "VoteApprove" | "VoteReject") {
      const p = this.get(id);
      if (p.status !== "InProgress") throw new Error(`Proposal #${id} is ${p.status}`);
      p.votes[member] = action === "VoteApprove" ? "Approve" : "Reject";
      const yes = Object.values(p.votes).filter((v) => v === "Approve").length;
      const no = Object.values(p.votes).filter((v) => v === "Reject").length;
      if (yes >= APPROVAL_THRESHOLD_SIGNERS) p.status = "Approved";
      else if (no >= APPROVAL_THRESHOLD_SIGNERS) p.status = "Rejected";
      return p;
    },
  };
}
