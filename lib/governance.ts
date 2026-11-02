import { ASSET_ID } from "./chains";
import { APPROVAL_THRESHOLD_SIGNERS, DAO_ACCOUNT, POLICY_VIA_DAO, SIGNER_NAMES, TREZU_APP_URL } from "./config";
import { canonical, sha256 } from "./crypto";
import { addDaoProposal, checkCustody, viewDao } from "./custody";
import { makePolicy } from "./policy";
import { currentPolicy, state } from "./store";
import type { PolicyProposal } from "./types";

/**
 * Who may change the policy.
 *  - Sputnik custody (POLICY_VIA_DAO): the treasury DAO itself. A signer drafts the change here; a council member
 *    adds a `Vote` proposal to the DAO carrying the change's tag; the council votes onchain; this app applies the change
 *    only once it reads that proposal as Approved from the chain. The multisig is the DAO's, not ours.
 *  - Otherwise: M-of-N named signers (each signs in with their own token), an application-level multisig.
 * Either way policy only changes through approvals, and every version is hashed.
 */
const KNOWN_CHAINS = new Set(Object.keys(ASSET_ID).map((k) => k.split(":")[0]));
const KNOWN_ASSETS = new Set(Object.keys(ASSET_ID).map((k) => k.split(":")[1]));

/** Rejects a policy that could not work or would silently disable a rule. */
export function validateChanges(c: PolicyProposal["changes"]) {
  const nums: [string, number][] = [
    ["Per-payment limit", c.perPaymentLimitUsd], ["Daily limit", c.dailyLimitUsd], ["Approval threshold", c.approvalThresholdUsd],
    ["Hold window", c.holdWindowMinutes], ["API spend per day", c.x402DailyLimitUsd],
  ];
  for (const [n, v] of nums) if (!Number.isFinite(v) || v < 0) throw new Error(`${n} must be zero or more.`);
  if (c.perPaymentLimitUsd === 0 || c.dailyLimitUsd === 0) throw new Error("A limit of 0 would stop every payment. Use the kill switch for that.");
  if (c.dailyLimitUsd < c.perPaymentLimitUsd) throw new Error("The daily limit cannot be below the per-payment limit.");
  if (!c.allowedChains.length || !c.allowedAssets.length) throw new Error("Allow at least one chain and one asset.");
  const badChain = c.allowedChains.find((x) => !KNOWN_CHAINS.has(x));
  if (badChain) throw new Error(`Unknown chain "${badChain}". Supported: ${[...KNOWN_CHAINS].join(", ")}.`);
  const badAsset = c.allowedAssets.find((x) => !KNOWN_ASSETS.has(x));
  if (badAsset) throw new Error(`Unknown asset "${badAsset}". Supported: ${[...KNOWN_ASSETS].join(", ")}.`);
  if (c.privacyFloor !== undefined && !["public", "basic", "advanced"].includes(c.privacyFloor)) throw new Error("The privacy floor must be public, basic or advanced.");
  if (c.requirePostQuantumKeys !== undefined && typeof c.requirePostQuantumKeys !== "boolean") throw new Error("Require post-quantum keys must be true or false.");
}

/** The tag a DAO proposal must carry: the version it becomes and a hash of the exact rules. */
export const daoPolicyTag = (version: number, changes: PolicyProposal["changes"]) => `bluvfi-policy:v${version}:${sha256(canonical(changes))}`;

/**
 * The proposal that carries a policy change. Trezu-style DAOs give their roles call/transfer proposals but no `Vote`
 * kind, so it is a FunctionCall to the DAO itself that only runs a view method: it changes nothing when executed, and
 * its description holds the tag. The agent's scoped key can file it; the council's vote is the approval.
 */
const carrierKind = () => ({
  FunctionCall: { receiver_id: DAO_ACCOUNT, actions: [{ method_name: "get_last_proposal_id", args: Buffer.from("{}").toString("base64"), deposit: "0", gas: "5000000000000" }] },
});

/** True for a proposal of the carrier shape (or a plain `Vote` proposal, for DAOs that have that kind). */
export function isPolicyCarrier(kind: unknown): boolean {
  if (kind === "Vote") return true;
  const fc = (kind as { FunctionCall?: { receiver_id?: string; actions?: { method_name?: string }[] } } | null)?.FunctionCall;
  return !!fc && fc.receiver_id === DAO_ACCOUNT && !!fc.actions?.length && fc.actions.every((a) => a.method_name === "get_last_proposal_id");
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/** The text (and command) a council member uses to put this change to the DAO. */
function daoPolicyText(version: number, changes: PolicyProposal["changes"]) {
  const tag = daoPolicyTag(version, changes);
  const description =
    `Bluvfi Business policy v${version}: per payment ${usd(changes.perPaymentLimitUsd)}, daily ${usd(changes.dailyLimitUsd)}, ` +
    `signer approval from ${usd(changes.approvalThresholdUsd)}, hold ${changes.holdWindowMinutes} min, chains ${changes.allowedChains.join("/")}, ` +
    `assets ${changes.allowedAssets.join("/")}, ${changes.vendorAllowlist.length} allowlisted vendor(s), API spend ${usd(changes.x402DailyLimitUsd)}/day, ` +
    `privacy floor ${changes.privacyFloor ?? "public"}, post-quantum keys ${changes.requirePostQuantumKeys ? "required" : "optional"}. ${tag}`;
  const kind = carrierKind();
  const args = JSON.stringify({ proposal: { description, kind } });
  return {
    tag,
    description,
    kind,
    command: `near contract call-function as-transaction ${DAO_ACCOUNT} add_proposal json-args '${args}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet`,
    url: `${TREZU_APP_URL}/${DAO_ACCOUNT}/requests`,
  };
}

export function propose(changes: PolicyProposal["changes"], signer: string): PolicyProposal {
  if (!SIGNER_NAMES.includes(signer)) throw new Error("Unknown signer");
  validateChanges(changes);
  const next = currentPolicy().version + 1;
  const p: PolicyProposal = {
    id: `prop-${sha256(JSON.stringify(changes) + Date.now()).slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    changes,
    approvals: [signer],
    threshold: APPROVAL_THRESHOLD_SIGNERS,
    status: "open",
    ...(POLICY_VIA_DAO ? { dao: { version: next, ...daoPolicyText(next, changes) } } : {}),
  };
  state().proposals.unshift(p);
  maybeApply(p);
  return p;
}

export function approveProposal(id: string, signer: string): PolicyProposal {
  if (!SIGNER_NAMES.includes(signer)) throw new Error("Unknown signer");
  const p = state().proposals.find((x) => x.id === id);
  if (!p) throw new Error("Proposal not found");
  if (p.dao) throw new Error("This change is approved by the treasury DAO's council, not by app signers. Put it to the DAO, then check the DAO.");
  if (p.status === "applied") return p;
  if (!p.approvals.includes(signer)) p.approvals.push(signer);
  maybeApply(p);
  return p;
}

const DEAD = new Set(["Rejected", "Removed", "Expired", "Moved", "Failed"]);

/** The agent files the proposal that carries this change (add_proposal with its scoped key). The council still has to approve it. */
export async function proposeToDao(id: string): Promise<PolicyProposal> {
  const p = state().proposals.find((x) => x.id === id);
  if (!p?.dao) throw new Error("This proposal is not waiting for the DAO.");
  if (p.dao.proposalId !== undefined) throw new Error(`Already sent to the DAO as proposal #${p.dao.proposalId}.`);
  const check = await checkCustody();
  if (!check.ok) throw new Error(`Custody check failed: ${check.problems.join(" ")}`);
  p.dao.proposalId = await addDaoProposal(p.dao.kind, p.dao.description);
  p.dao.daoStatus = "InProgress";
  return p;
}

/** Reads the DAO's recent proposals from the chain and applies the change if its Vote proposal is Approved. */
export async function syncDaoProposal(id: string): Promise<PolicyProposal> {
  const p = state().proposals.find((x) => x.id === id);
  if (!p?.dao) throw new Error("This proposal is not waiting for the DAO.");
  if (p.status === "applied") return p;
  if (p.dao.version !== currentPolicy().version + 1) throw new Error("The policy changed after this was drafted. Draft the change again.");
  const last = await viewDao<number>("get_last_proposal_id");
  const from = Math.max(0, last - 200);
  const recent = await viewDao<{ id: number; status: string; kind: unknown; description: string }[]>("get_proposals", { from_index: from, limit: Math.max(1, last - from) });
  const hit = recent.find((x) => isPolicyCarrier(x.kind) && x.description.includes(p.dao!.tag));
  if (!hit) throw new Error(`No DAO proposal carries this change's tag yet. Add it with the command shown, then check again.`);
  p.dao.proposalId = hit.id;
  p.dao.daoStatus = hit.status;
  if (hit.status === "Approved") {
    state().policies.push(makePolicy(p.dao.version, p.changes));
    p.status = "applied";
  } else if (DEAD.has(hit.status)) {
    p.status = "rejected";
  }
  return p;
}

function maybeApply(p: PolicyProposal) {
  if (p.dao) return; // the DAO decides, see syncDaoProposal
  if (p.status === "open" && p.approvals.length >= p.threshold) {
    state().policies.push(makePolicy(currentPolicy().version + 1, p.changes));
    p.status = "applied";
  }
}
