import { Badge, Empty, PageHead, STATUS, short, usd, when } from "@/components/ui";
import { state } from "@/lib/store";
import { currentSession, publicBiz, tenantPage } from "@/lib/who";
import { bizName } from "@/lib/business";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { LedgerToggle } from "./Toggle";

export const dynamic = "force-dynamic";

/** The ledger is public per business: `?b=<business id>` opens that business's, if it chose to publish it. */
async function Ledger() {
  const session = await currentSession();
  const signer = session && session.biz === currentBiz() ? session.name : "";
  const s = state();
  return (
    <>
      <PageHead
        title={`Public ledger · ${bizName()}`}
        sub="For DAOs that choose full transparency. Everything the agent paid or stopped, visible to anyone. Off by default."
        right={signer ? <LedgerToggle on={s.ledgerPublic} /> : undefined}
      />
      {signer && s.ledgerPublic && (
        <p className="mb-4 text-sm" style={{ color: "var(--tx-1)" }}>Anyone can open this at <span className="mono">{currentBiz() === DEFAULT_BIZ ? "/ledger" : `/ledger?b=${currentBiz()}`}</span>.</p>
      )}
      {!s.ledgerPublic ? (
        <Empty title="This treasury keeps its ledger private" hint="Switch transparency on to publish payments here. Companies can instead grant an auditor a time-limited view key on the Auditor page." />
      ) : s.payments.length === 0 ? (
        <Empty title="Nothing to show yet" hint="Payments appear here as the agent handles them." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="t">
            <thead><tr className="label"><th>When</th><th>Vendor</th><th>Amount</th><th>Status</th><th>Policy</th><th>Record</th></tr></thead>
            <tbody>
              {s.payments.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap">{when(p.createdAt)}</td>
                  <td>{p.invoice.vendorName}</td>
                  <td className="amount">{usd(p.invoice.amountUsd)}</td>
                  <td><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge></td>
                  <td className="mono">v{p.verified.policyVersion}</td>
                  <td className="mono text-xs">{short(p.recordHash, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default tenantPage(Ledger, ({ searchParams }: { searchParams: Promise<{ b?: string }> }) => publicBiz(searchParams));
