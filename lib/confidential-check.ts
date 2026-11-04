import { deepStrictEqual } from "node:assert";
import { daoDerivedKey, findMpcSignature, SIGNER_CONTRACT, signProposal } from "./confidential";
import { viewFn } from "./custody";

/**
 * Will this DAO work as a confidential treasury for Bluvfi Business? A NEAR Business or Trezu confidential treasury is a public
 * Sputnik DAO, so everything that matters can be read from the chain with no access to anyone's app: its policy, whether the agent can
 * file proposals into it, and, if it has been made confidential before, the signing requests the council approved, which are compared
 * with the ones this app would file. Read-only: it files nothing and signs nothing.
 *
 * What it cannot see is the shielded balance and the 1Click login: those are private to the council by design.
 */
export interface CompatFinding { ok: boolean | null; text: string }

export interface SignRequest {
  id: number;
  status: string;
  description: string;
  /** "treasury" if the request signs for the DAO's own account (a login or a payout); "other" for anything else the DAO used the signer for. */
  kind: "treasury" | "other";
  /** For treasury requests: does it equal, field for field, what this app files for the same hash? */
  sameAsOurs?: boolean;
  /** For approved treasury requests: is the signature on the chain, and does it verify under the DAO's key for that hash? null = not found on the index. */
  signatureVerified?: boolean | null;
}

export interface CompatReport {
  dao: string;
  verdict: "compatible" | "compatible_untested" | "incompatible";
  findings: CompatFinding[];
  signRequests: SignRequest[];
  derivedKey?: string;
}

interface Role { name: string; kind: "Everyone" | { Group: string[] } | { Member: string }; permissions: string[] }
interface Policy { proposal_bond: string; roles: Role[]; default_vote_policy?: { threshold: [number, number] | string } }
interface DaoProposal { id: number; description: string; status: string; kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] } } | string }

/** A permission that lets its holder approve or reject a call proposal. */
const VOTES_ON_CALLS = /^(call|\*):(VoteApprove|VoteReject|\*)$/;

/** A proposal kind with its encoded arguments decoded, so two kinds compare by what they say and not by how their JSON happens to be ordered. */
const decoded = (kind: unknown) => {
  const k = JSON.parse(JSON.stringify(kind)) as { FunctionCall?: { actions: { args: string | Record<string, unknown> }[] } };
  for (const a of k.FunctionCall?.actions ?? []) if (typeof a.args === "string") a.args = JSON.parse(Buffer.from(a.args, "base64").toString()) as Record<string, unknown>;
  return k;
};
const members = (r: Role) => (typeof r.kind === "object" && "Group" in r.kind ? r.kind.Group : []);
const can = (r: Role, what: string) => r.permissions.some((p) => p === what || p === "*:*" || p === `${what.split(":")[0]}:*` || p === `*:${what.split(":")[1]}`);

export async function checkConfidentialCompat(dao: string, agent?: string): Promise<CompatReport> {
  const findings: CompatFinding[] = [];
  const note = (ok: boolean | null, text: string) => findings.push({ ok, text });
  const report = (verdict: CompatReport["verdict"], extra: Partial<CompatReport> = {}): CompatReport => ({ dao, verdict, findings, signRequests: [], ...extra });

  let policy: Policy;
  try {
    policy = await viewFn<Policy>(dao, "get_policy");
    note(true, `${dao} is a Sputnik DAO: its policy has ${policy.roles.length} roles (${policy.roles.map((r) => r.name).join(", ")}).`);
  } catch (e) {
    note(false, `${dao} has no readable Sputnik policy (${(e as Error).message}), so it is not a Sputnik DAO. A confidential treasury is one.`);
    return report("incompatible");
  }

  // The agent files with a function-call key that attaches no deposit, so the proposal bond must be zero.
  if (policy.proposal_bond === "0") note(true, "The proposal bond is 0, so the agent's function-call key (no deposit) can file proposals.");
  else note(false, `The proposal bond is ${policy.proposal_bond} yoctoNEAR. The agent's key attaches no deposit, so it could not file. The council has to set the bond to 0.`);

  // Who may file `call` proposals without being able to vote: the Requestor-style role the agent belongs in.
  const filers = policy.roles.filter((r) => can(r, "call:AddProposal") && !r.permissions.some((p) => VOTES_ON_CALLS.test(p)));
  if (agent) {
    const held = policy.roles.filter((r) => members(r).includes(agent));
    const votes = held.filter((r) => r.permissions.some((p) => VOTES_ON_CALLS.test(p)));
    const files = held.some((r) => can(r, "call:AddProposal"));
    if (votes.length) note(false, `${agent} can vote through the role "${votes[0].name}". The agent must only be able to propose; move it to a role that cannot vote.`);
    else if (files) note(true, `${agent} can file call proposals and holds no voting rights (role "${held.find((r) => can(r, "call:AddProposal"))!.name}").`);
    else note(false, `${agent} is not in a role that can file call proposals. Add it to ${filers.length ? `the "${filers[0].name}" role` : "a role with call:AddProposal"}.`);
  } else if (filers.length) {
    note(true, `The agent can be added to "${filers[0].name}", which can file call proposals and cannot vote (${members(filers[0]).length} member${members(filers[0]).length === 1 ? "" : "s"} today).`);
  } else {
    note(false, "No role can file call proposals without voting rights. The agent needs a Requestor-style role.");
  }

  const approvers = policy.roles.filter((r) => can(r, "call:VoteApprove"));
  if (approvers.length) note(true, `The council can approve: "${approvers[0].name}" (${members(approvers[0]).length} member${members(approvers[0]).length === 1 ? "" : "s"}) holds call:VoteApprove.`);
  else note(false, "No role can approve call proposals, so a signing request could never be approved.");

  let derivedKey: string | undefined;
  try {
    derivedKey = await daoDerivedKey(dao);
    note(true, `NEAR's MPC signer derives this DAO's key: ${derivedKey}. This is the account Confidential Intents checks its signatures against.`);
  } catch (e) {
    note(false, `The MPC signer would not derive a key for this DAO (${(e as Error).message}).`);
  }

  // Its own history: any request to the signer is read and compared with what this app would file for the same hash.
  const signRequests: SignRequest[] = [];
  try {
    const last = await viewFn<number>(dao, "get_last_proposal_id");
    const proposals = await viewFn<DaoProposal[]>(dao, "get_proposals", { from_index: Math.max(0, last - 100), limit: 100 });
    for (const p of proposals) {
      const fc = typeof p.kind === "object" ? p.kind.FunctionCall : undefined;
      if (!fc || fc.receiver_id !== SIGNER_CONTRACT || fc.actions[0]?.method_name !== "sign") continue;
      const args = JSON.parse(Buffer.from(fc.actions[0].args, "base64").toString()) as { request?: { path?: string; payload_v2?: { Eddsa?: string } } };
      const hashHex = args.request?.payload_v2?.Eddsa;
      const treasury = args.request?.path === dao && !!hashHex;
      const entry: SignRequest = { id: p.id, status: p.status, description: p.description, kind: treasury ? "treasury" : "other" };
      if (treasury) {
        try {
          deepStrictEqual(decoded(p.kind), decoded(signProposal(dao, hashHex!)));
          entry.sameAsOurs = true;
        } catch {
          entry.sameAsOurs = false;
        }
        if (p.status === "Approved" && derivedKey) {
          const sig = await findMpcSignature(dao, hashHex!, derivedKey).catch(() => undefined);
          entry.signatureVerified = sig ? true : null;
        }
      }
      signRequests.push(entry);
    }
  } catch (e) {
    note(null, `The DAO's proposal history could not be read (${(e as Error).message}).`);
  }

  const treasury = signRequests.filter((s) => s.kind === "treasury");
  if (!treasury.length) {
    note(null, "This DAO has no signing requests for its own account yet, so there is nothing of its to compare with. Nothing here says it would not work.");
  } else {
    const same = treasury.filter((s) => s.sameAsOurs).length;
    note(same === treasury.length, `${same} of ${treasury.length} signing request${treasury.length === 1 ? "" : "s"} for this DAO's own account (${treasury.map((s) => `#${s.id} "${s.description.slice(0, 40)}"`).join(", ")}) ${same === treasury.length ? "match exactly what this app files: the same signer, method, 1 yoctoNEAR, 250 Tgas, path and domain." : "differ from what this app files."}`);
    const verified = treasury.filter((s) => s.signatureVerified).length;
    const approved = treasury.filter((s) => s.status === "Approved").length;
    if (approved) note(verified === approved ? true : verified ? null : null, `${verified} of ${approved} approved request${approved === 1 ? "" : "s"} have their MPC signature on the chain, and it verifies under the DAO's key for that exact hash.`);
  }

  const bad = findings.some((f) => f.ok === false);
  const known = treasury.length > 0;
  return report(bad ? "incompatible" : known ? "compatible" : "compatible_untested", { signRequests, derivedKey });
}
