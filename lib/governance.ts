import { APPROVAL_THRESHOLD_SIGNERS, SIGNER_NAMES } from "./config";
import { makePolicy } from "./policy";
import { currentPolicy, state } from "./store";
import { sha256 } from "./crypto";
import type { PolicyProposal } from "./types";

/**
 * M-of-N approval of policy changes by named signers (each signs in with their own token).
 * This is an application-level multisig, not an onchain one.
 * Policy only changes when enough distinct signers approve, and every version is hashed.
 */
export function propose(changes: PolicyProposal["changes"], signer: string): PolicyProposal {
  if (!SIGNER_NAMES.includes(signer)) throw new Error("Unknown signer");
  const p: PolicyProposal = {
    id: `prop-${sha256(JSON.stringify(changes) + Date.now()).slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    changes,
    approvals: [signer],
    threshold: APPROVAL_THRESHOLD_SIGNERS,
    status: "open",
  };
  state().proposals.unshift(p);
  maybeApply(p);
  return p;
}

export function approveProposal(id: string, signer: string): PolicyProposal {
  if (!SIGNER_NAMES.includes(signer)) throw new Error("Unknown signer");
  const p = state().proposals.find((x) => x.id === id);
  if (!p) throw new Error("Proposal not found");
  if (p.status === "applied") return p;
  if (!p.approvals.includes(signer)) p.approvals.push(signer);
  maybeApply(p);
  return p;
}

function maybeApply(p: PolicyProposal) {
  if (p.status === "open" && p.approvals.length >= p.threshold) {
    state().policies.push(makePolicy(currentPolicy().version + 1, p.changes));
    p.status = "applied";
  }
}
