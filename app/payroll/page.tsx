import Link from "next/link";
import { ActionButton } from "@/components/Actions";
import { Badge, Empty, PageHead } from "@/components/ui";
import { cfg } from "@/lib/business";
import { CHAIN_LABEL } from "@/lib/chains";
import { PER_PROPOSAL, payrollRuns, SAMPLE_CSV, type PayrollRow, type PayrollRun } from "@/lib/payroll";
import { isDemo } from "@/lib/tenant";
import { tenantPage } from "@/lib/who";
import { PayrollUpload } from "./PayrollUpload";

export const dynamic = "force-dynamic";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const ROW: Record<PayrollRow["status"], [string, "ok" | "warn" | "bad" | "default"]> = {
  ready: ["Ready", "default"], blocked: ["Blocked", "bad"], proposed: ["Waiting for the council", "warn"], sent: ["On its way", "warn"],
  paid: ["Paid", "ok"], refunded: ["Refunded", "default"], failed: ["Failed", "bad"], expired: ["Expired", "bad"], rejected: ["Rejected", "default"],
};
const RUN: Record<PayrollRun["status"], [string, "ok" | "warn" | "bad" | "default"]> = {
  draft: ["Checked, not sent", "default"], proposed: ["With the council", "warn"], done: ["Done", "ok"], cancelled: ["Cancelled", "default"],
};

function Run({ r, dao }: { r: PayrollRun; dao: boolean }) {
  const blocked = r.rows.filter((x) => x.verdict === "block").length;
  const warned = r.rows.filter((x) => x.verdict === "warn").length;
  const paid = r.rows.filter((x) => x.status === "paid").length;
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2>{r.title}</h2>
          <p className="text-sm" style={{ color: "var(--tx-2)" }}>{r.rows.length} {r.rows.length === 1 ? "person" : "people"} · {usd(r.totalUsd)} · checked {new Date(r.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} by {r.createdBy}{r.sentBy ? ` · sent by ${r.sentBy}` : ""}</p>
        </div>
        <Badge tone={RUN[r.status][1]}>{RUN[r.status][0]}{r.status !== "draft" && r.status !== "cancelled" ? ` · ${paid} of ${r.rows.length} paid` : ""}</Badge>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="t text-sm">
          <thead><tr className="label"><th>Line</th><th>Name</th><th>Amount</th><th>Paid in</th><th>Address</th><th>Checks</th><th>Status</th></tr></thead>
          <tbody>
            {r.rows.map((x) => {
              const flagged = x.checks.filter((c) => c.verdict !== "allow");
              return (
                <tr key={x.line}>
                  <td>{x.line}</td>
                  <td>{x.name}</td>
                  <td className="amount">{usd(x.amountUsd)}</td>
                  <td>{x.asset} on {CHAIN_LABEL[x.chain]}</td>
                  <td className="mono text-xs break-all">{x.address}</td>
                  <td>{flagged.length ? flagged.map((c) => <div key={c.id} className={c.verdict === "block" ? "neg" : ""} style={c.verdict === "warn" ? { color: "#e8a838" } : undefined}>{c.verdict === "block" ? "✕" : "!"} {c.reason}</div>) : <span className="pos">✓ all passed</span>}</td>
                  <td><Badge tone={ROW[x.status][1]}>{ROW[x.status][0]}</Badge>{x.note && <div className="text-xs mt-1" style={{ color: "var(--tx-2)" }}>{x.note}</div>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {r.proposals.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm">
          {r.proposals.map((p) => <li key={p.id}>DAO proposal <a href={p.url} style={{ color: "#8c8cff" }}>#{p.id}</a> for {p.rows.length} {p.rows.length === 1 ? "person" : "people"}: {p.detail}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.status === "draft" && (
          blocked
            ? <span className="text-sm neg">{blocked} line{blocked === 1 ? "" : "s"} blocked: fix the sheet and upload it again.</span>
            : dao
              ? <ActionButton url="/api/payroll" payload={{ action: "send", id: r.id }} variant="primary" done="Sent to the council" confirm={`Send ${usd(r.totalUsd)} to ${r.rows.length} people to the council for one approval?${warned ? ` ${warned} line(s) have warnings: check them first.` : ""}`}>Send to the council for approval</ActionButton>
              : <span className="text-sm" style={{ color: "var(--tx-2)" }}>Payroll is paid by one council vote, so the treasury must be a Sputnik DAO (Trezu).</span>
        )}
        {r.status === "draft" && <ActionButton url="/api/payroll" payload={{ action: "cancel", id: r.id }} variant="ghost" done="Cancelled">Cancel</ActionButton>}
        {r.status === "proposed" && isDemo() && (
          <>
            <ActionButton url="/api/payroll" payload={{ action: "vote", id: r.id, approve: true }} small done="Your vote is in">Vote approve (demo council)</ActionButton>
            <ActionButton url="/api/payroll" payload={{ action: "vote", id: r.id, approve: false }} small variant="ghost" done="Your vote is in">Vote reject</ActionButton>
          </>
        )}
        {r.status === "proposed" && <ActionButton url="/api/payroll" payload={{ action: "refresh", id: r.id }} small variant="ghost" done="Updated">Check progress</ActionButton>}
      </div>
    </section>
  );
}

function Payroll() {
  const runs = payrollRuns();
  const dao = cfg().CUSTODY === "sputnik" || cfg().CUSTODY === "hybrid";
  return (
    <>
      <PageHead
        title="Payroll"
        sub={`Upload a sheet, and each person is paid in the stablecoin and chain they chose. The council approves the whole run once in Trezu (one DAO proposal per ${PER_PROPOSAL} people), and NEAR Intents delivers everyone's money. The agent only proposes; the council's vote pays.`}
      />
      {!dao && <p role="status" className="card mb-4 text-sm" style={{ color: "var(--tx-1)" }}>Payroll is approved by one council vote, so it needs a Sputnik DAO treasury (Trezu). You can still upload and check a sheet. <Link href="/" style={{ color: "#8c8cff" }}>Set up a treasury on the Overview →</Link></p>}
      <PayrollUpload sample={SAMPLE_CSV} />
      <div className="mt-4 grid gap-4">
        {runs.length === 0 ? <Empty title="No payroll yet" hint="Upload a sheet above, or press Use the example to see how it works." /> : runs.map((r) => <Run key={r.id} r={r} dao={dao} />)}
      </div>
    </>
  );
}

export default tenantPage(Payroll);
