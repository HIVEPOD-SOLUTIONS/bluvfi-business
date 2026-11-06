import { Badge, PageHead, when } from "@/components/ui";
import { OWNER_EMAILS, PRIVY_LOGIN, SIGNER_NAMES } from "@/lib/config";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { approvalThreshold, isOwner, members, signerNames } from "@/lib/team";
import { currentSigner, tenantPage } from "@/lib/who";
import { KybControl } from "@/components/Kyb";
import { getBusiness } from "@/lib/business";
import { kybEnabled } from "@/lib/kyb";
import { passportEnabled } from "@/lib/passport";
import { TeamEditor } from "./TeamEditor";

export const dynamic = "force-dynamic";

async function TeamPage() {
  const signer = (await currentSigner()) ?? "";
  const list = members();
  const owner = isOwner(signer);
  return (
    <>
      <PageHead
        title="Team"
        sub={`Who can approve payments and policy changes. A policy change needs ${approvalThreshold()} of ${signerNames().length} signers.`}
        right={<Badge tone={owner ? "gold" : "default"}>{owner ? "You are an owner" : "You are an approver"}</Badge>}
      />
      {!PRIVY_LOGIN && (
        <p role="alert" className="card mb-4 text-sm" style={{ color: "var(--tx-1)" }}>
          Sign in with Privy is not set up, so people can only join with a signer token. Set PRIVY_APP_ID and PRIVY_APP_SECRET in .env.local, then restart.
        </p>
      )}
      {signerNames().length < 2 && (
        <p role="alert" className="card mb-4 text-sm neg">Only one signer exists, so one person can approve a policy change alone. Add a second approver.</p>
      )}
      {(kybEnabled() || passportEnabled()) && currentBiz() !== DEFAULT_BIZ && owner && (
        <div className="card mb-4">
          <h2>Verify your business</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Your council&apos;s policy says when your business must be verified (for example from an amount, or for confidential payments). Verify with documents through Persona, or, if the policy accepts it, with a passport proof that shares no document.</p>
          <KybControl kind="business" kyb={getBusiness(currentBiz())?.kyb} passport={getBusiness(currentBiz())?.passport} personaOn={kybEnabled()} passportOn={passportEnabled()} label="Start verification" />
        </div>
      )}
      <div className="grid gap-2">
        {currentBiz() === DEFAULT_BIZ && SIGNER_NAMES.map((n) => (
          <div key={n} className="card flex items-center justify-between gap-3">
            <span className="mono">{n}</span>
            <Badge tone="gold">Owner · signer token</Badge>
          </div>
        ))}
        {list.map((m) => (
          <div key={m.email} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="mono">{m.email}</span>
              {m.addedBy && <span className="ml-2 text-sm" style={{ color: "var(--tx-2)" }}>added by {m.addedBy}{m.addedAt ? `, ${when(m.addedAt)}` : ""}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={m.role === "owner" ? "gold" : "blue"}>{m.role === "owner" ? "Owner" : "Approver"}</Badge>
              {owner && m.email !== signer && !(currentBiz() === DEFAULT_BIZ && OWNER_EMAILS.includes(m.email)) && <TeamEditor remove={m.email} />}
            </div>
          </div>
        ))}
      </div>
      {owner && PRIVY_LOGIN && <div className="mt-6"><h2 className="mb-2">Add someone to the team</h2><TeamEditor /></div>}
    </>
  );
}

export default tenantPage(TeamPage);
