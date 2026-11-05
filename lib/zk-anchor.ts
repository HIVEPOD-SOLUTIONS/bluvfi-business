import { createHash } from "node:crypto";
import { cfg } from "./business";
import { addDaoProposal, checkCustody, viewDao } from "./custody";
import { carrierKind, isPolicyCarrier } from "./governance";
import { attesters, attestThreshold, issuerPublicKey } from "./zk-claims";

/**
 * Who may issue credentials and balance attestations is itself something to pin down. The set of issuer keys and the threshold are put to the
 * treasury DAO as a proposal (the same kind of proposal that carries a policy change: it changes nothing when run, and its description holds
 * a tag). When the council approves it, the set is recorded on the NEAR chain, in a vote the issuer cannot rewrite. A verifier can then check
 * that the keys named in a proof are the ones the council approved. No contract of ours is involved.
 */
export interface IssuerSet { issuers: string[]; threshold: number }

export async function currentIssuerSet(): Promise<IssuerSet> {
  const own = await issuerPublicKey();
  const keys = [own, ...attesters().map((a) => a.publicKey)];
  return { issuers: keys, threshold: attestThreshold() };
}

/** A hash of exactly this set (the order of issuers does not matter, repeats do not count). */
export const issuerSetHash = (s: IssuerSet) => createHash("sha256").update(JSON.stringify({ issuers: [...new Set(s.issuers)].sort(), threshold: s.threshold })).digest("hex");
export const anchorTag = (s: IssuerSet) => `bluvfi-zk-issuers:${issuerSetHash(s)}`;

/** The agent files the proposal (with its scoped key); the council approves it in the DAO. */
export async function anchorIssuers(): Promise<{ tag: string; proposalId: number; set: IssuerSet }> {
  const set = await currentIssuerSet();
  const check = await checkCustody();
  if (!check.ok) throw new Error(`Custody check failed: ${check.problems.join(" ")}`);
  const tag = anchorTag(set);
  const description = `Bluvfi Business zero-knowledge issuers: ${new Set(set.issuers).size} key(s), ${set.threshold} must sign. ${tag}`;
  const proposalId = await addDaoProposal(carrierKind(), description);
  return { tag, proposalId, set };
}

export interface AnchorStatus { anchored: boolean; status?: string; proposalId?: number; tag: string; set: IssuerSet }

/** Is this issuer set approved by the DAO's council, on chain? Looks through the DAO's recent proposals for the tag. */
export async function anchorStatus(set?: IssuerSet): Promise<AnchorStatus> {
  const s = set ?? (await currentIssuerSet());
  const tag = anchorTag(s);
  if (!cfg().DAO_ACCOUNT) return { anchored: false, status: "No treasury DAO is set up", tag, set: s };
  const last = await viewDao<number>("get_last_proposal_id");
  const from = Math.max(0, last - 500);
  const recent = await viewDao<{ id: number; status: string; kind: unknown; description: string }[]>("get_proposals", { from_index: from, limit: Math.max(1, last - from) });
  const hits = recent.filter((p) => isPolicyCarrier(p.kind) && p.description.includes(tag));
  const approved = hits.find((p) => p.status === "Approved");
  const hit = approved ?? hits[hits.length - 1];
  return { anchored: !!approved, status: hit?.status ?? "Not proposed yet", proposalId: hit?.id, tag, set: s };
}
