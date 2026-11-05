import { cfg } from "@/lib/business";
import { Badge, PageHead, short, when } from "@/components/ui";
import { verifyPolicyHistory } from "@/lib/policy";

import { approvalThreshold, signerNames } from "@/lib/team";
import { currentSigner, tenantPage } from "@/lib/who";
import { currentPolicy, state } from "@/lib/store";
import { DaoProposalBox, PolicyEditor, ProposalActions } from "./Editor";

export const dynamic = "force-dynamic";

async function PolicyPage() {
  const signer = (await currentSigner()) ?? "";
  const s = state();
  const p = currentPolicy();
  const history = verifyPolicyHistory(s.policies);
  return (
    <>
      <PageHead
        title="Policy"
        sub={`The rules the agent cannot break. ${cfg().POLICY_VIA_DAO ? "Changes become a Vote proposal that the treasury DAO's council approves onchain." : `Changes become a proposal that ${approvalThreshold()} of ${signerNames().length} signers must approve.`} Every version is hashed.`}
        right={<Badge tone="blue">v{p.version} · <span className="mono">{short(p.hash, 6)}</span></Badge>}
      />
      <PolicyEditor policy={p} signer={signer} />

      <h2 className="mt-8 mb-3">Proposals</h2>
      {s.proposals.length === 0 ? (
        <p style={{ color: "var(--tx-1)" }}>No proposals yet. Edit a rule above to create one.</p>
      ) : (
        <div className="grid gap-3">
          {s.proposals.map((pr) => (
            <div key={pr.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="mono text-sm">{pr.id}</span> <span className="text-sm" style={{ color: "var(--tx-2)" }}>· {when(pr.createdAt)}</span></div>
                <Badge tone={pr.status === "applied" ? "ok" : pr.status === "rejected" ? "bad" : "warn"}>{pr.status === "applied" ? "Applied" : pr.status === "rejected" ? "Rejected by the DAO" : pr.dao ? "Waiting for the DAO" : `${pr.approvals.length}/${pr.threshold} approvals`}</Badge>
              </div>
              <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
                Per payment ${pr.changes.perPaymentLimitUsd.toLocaleString()} · daily ${pr.changes.dailyLimitUsd.toLocaleString()} · approval at ${pr.changes.approvalThresholdUsd.toLocaleString()} · hold {pr.changes.holdWindowMinutes} min · chains {pr.changes.allowedChains.join(", ")} · privacy floor {pr.changes.privacyFloor ?? "public"}{pr.changes.privacyProfile ? ` (${pr.changes.privacyProfile})` : ""}{pr.changes.privacyTiers?.length ? ` · ${pr.changes.privacyTiers.length} amount tier(s)` : ""}{Object.keys(pr.changes.privateVendors ?? {}).length ? ` · ${Object.keys(pr.changes.privateVendors ?? {}).length} private vendor(s)` : ""} · post-quantum keys {pr.changes.requirePostQuantumKeys ? "required" : "optional"}
              </p>
              {pr.dao ? <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Drafted by {pr.approvals[0]}.</p> : <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Approved by: {pr.approvals.join(", ")}</p>}
              {pr.dao && pr.status === "open" && <DaoProposalBox id={pr.id} dao={pr.dao} />}
              {pr.status === "open" && <ProposalActions id={pr.id} signer={signer} approved={pr.approvals.includes(signer)} dao={!!pr.dao} />}
            </div>
          ))}
        </div>
      )}

      <h2 className="mt-8 mb-3">Version history</h2>
      <p className="mb-3 text-sm" style={{ color: history.ok ? "var(--sage)" : "var(--red-alert)" }}>{history.ok ? `All ${s.policies.length} version hash(es) recompute from their contents.` : `History does not verify: ${history.problems.join(" ")}`}</p>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr className="label"><th>Version</th><th>Created</th><th>Hash</th></tr></thead>
          <tbody>
            {[...s.policies].reverse().map((v) => (
              <tr key={v.version}><td className="mono">v{v.version}</td><td>{when(v.createdAt)}</td><td className="mono break-all text-xs">{v.hash}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card mt-8">
        <h2>How the agent is kept in check</h2>
        <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: "var(--tx-1)" }}>
          <li>The agent can only <em>request</em> a payment. Release happens inside the policy gate, which re-checks every rule at the moment of release.</li>
          <li>The AI can recommend. It can tighten a result, never loosen one. A fully tricked model still cannot move money.</li>
          <li>{cfg().POLICY_VIA_DAO ? "Policy changes only when the treasury DAO's council approves them onchain." : "Policy changes only through approvals from distinct signers."}</li>
          <li>Privacy is optional: the privacy floor raises every payment to at least that level, and at &quot;advanced&quot; the DAO proposal leaves out who is paid and why.</li>
          <li>With &quot;Require post-quantum keys&quot; on, payouts stop until the agent, relayer and every council member use ML-DSA keys. The Overview shows who still uses classical keys.</li>
          <li><strong>Honest note:</strong> there is no smart contract of ours. The gate is server code; {cfg().POLICY_VIA_DAO ? "the multisig is the DAO's council, onchain." : "the signers are application-level, not an onchain multisig."}</li>
        </ul>
      </section>
    </>
  );
}

export default tenantPage(PolicyPage);
