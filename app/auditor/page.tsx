import Link from "next/link";
import { tenantPage } from "@/lib/who";
import { Badge, Empty, PageHead, short, when } from "@/components/ui";
import { controls } from "@/lib/audit";
import { currentPolicy, state } from "@/lib/store";
import { GrantForm, GrantRow } from "./Forms";

export const dynamic = "force-dynamic";

function Auditor() {
  const s = state();
  const cs = controls();
  const head = s.payments[0]?.recordHash;
  return (
    <>
      <PageHead
        title="Auditor"
        sub="Controls an accountant can test, the evidence behind each one, and exports that open without questions."
        right={
          <div className="flex flex-wrap gap-2">
            <Link prefetch={false} className="btn btn-secondary" href="/api/audit/csv">Download CSV</Link>
            <Link prefetch={false} className="btn btn-secondary" href="/api/audit/pdf">Download PDF report</Link>
          </div>
        }
      />

      <section className="grid gap-3 md:grid-cols-2">
        {cs.map((c) => (
          <div key={c.id} className="card">
            <div className="flex items-start justify-between gap-2">
              <div><span className="label">{c.id}</span><h2>{c.name}</h2></div>
              <Badge tone={c.exceptions ? "bad" : s.payments.length ? "ok" : "default"}>{s.payments.length === 0 ? "No data" : c.exceptions ? `${c.exceptions} exception${c.exceptions > 1 ? "s" : ""}` : "No exceptions"}</Badge>
            </div>
            <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{c.description}</p>
            <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>{c.passed} passed · {c.detail}</p>
          </div>
        ))}
      </section>

      <section className="card mt-4">
        <h2>Evidence trail</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
          Each payment record is hashed, chained to the one before and signed with a post-quantum key (ML-DSA-65). A full copy is kept encrypted; only hashes are meant to be public. Anchoring the chain head on NEAR is the next step. Policy v{currentPolicy().version}.
        </p>
        <p className="mono mt-2 break-all text-xs" style={{ color: "var(--tx-2)" }}>Chain head: {head ?? "empty"}</p>
        {s.payments.length === 0 ? (
          <div className="mt-4"><Empty title="No records yet" hint="Records appear here as the agent handles invoices." /></div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="t">
              <thead><tr className="label"><th>When</th><th>Vendor</th><th>Result</th><th>Record</th></tr></thead>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap">{when(p.createdAt)}</td>
                    <td>{p.invoice.vendorName}</td>
                    <td>{p.headline}</td>
                    <td className="mono text-xs">{short(p.recordHash, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card mt-4">
        <h2>Selective disclosure</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
          Give an auditor or investor a view key for a period. They can read the records for that time, then it stops. Revoke any time.
        </p>
        <GrantForm />
        {s.grants.length > 0 && (
          <ul className="mt-4 divide-y" style={{ borderColor: "var(--bd)" }}>
            {s.grants.map((g) => <GrantRow key={g.id} id={g.id} grantee={g.grantee} expiresAt={g.expiresAt} revoked={g.revoked} />)}
          </ul>
        )}
        <p className="mt-4 text-sm" style={{ color: "var(--tx-1)" }}>Auditors open their records at <Link href="/view" style={{ color: "#8c8cff" }}>/view</Link>, no account needed.</p>
        <p className="mt-3 text-xs" style={{ color: "var(--tx-2)" }}>
          Honest note: expiry is enforced by this server. A key that was copied out cannot be made to expire by cryptography alone, which is why anchoring and per-period keys are on the roadmap.
        </p>
      </section>
    </>
  );
}

export default tenantPage(Auditor);
