import Link from "next/link";
import { Badge, Empty, PageHead, usd, when } from "@/components/ui";
import { CATEGORY_LABEL, filterHistory, historyEntries, type HistoryCategory } from "@/lib/history";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function History({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const all = historyEntries();
  const rows = filterHistory(all, q);
  const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
  const inUsd = rows.filter((r) => r.direction === "in" && r.tone === "ok").reduce((a, r) => a + r.amountUsd, 0);
  const outUsd = rows.filter((r) => r.direction === "out" && r.tone === "ok").reduce((a, r) => a + r.amountUsd, 0);
  return (
    <>
      <PageHead
        title="History"
        sub="Everything that moved, or was meant to: invoices paid, bills, investments, money received and put in, and what the agent spent on APIs and cards. All in one place."
        right={<a className="btn btn-secondary btn-sm" href={`/api/history?${new URLSearchParams({ ...Object.fromEntries(params), format: "csv" })}`}>Download CSV</a>}
      />
      <form className="card grid gap-3 sm:grid-cols-5" method="get">
        <label className="block sm:col-span-2"><span className="label">Search</span>
          <input className="input mt-1" name="q" defaultValue={q.q} placeholder="A name, an invoice number, a transaction" /></label>
        <label className="block"><span className="label">What</span>
          <select className="input mt-1" name="category" defaultValue={q.category ?? ""}>
            <option value="">Everything</option>
            {(Object.keys(CATEGORY_LABEL) as HistoryCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select></label>
        <label className="block"><span className="label">From</span><input className="input mt-1" type="date" name="from" defaultValue={q.from} /></label>
        <label className="block"><span className="label">To</span><input className="input mt-1" type="date" name="to" defaultValue={q.to} /></label>
        <div className="flex items-center gap-2 sm:col-span-5">
          <button className="btn btn-primary btn-sm">Show</button>
          {params.size > 0 && <Link className="btn btn-ghost btn-sm" href="/history">Clear</Link>}
          <span className="text-sm" style={{ color: "var(--tx-2)" }}>{rows.length} of {all.length} entries · in {usd(inUsd)} · out {usd(outUsd)} (settled only)</span>
        </div>
      </form>

      {all.length === 0 ? (
        <div className="mt-4"><Empty title="Nothing here yet" hint="Once the business pays an invoice, receives money or puts money into the treasury, it shows up here." icon="≡" /></div>
      ) : rows.length === 0 ? (
        <div className="mt-4"><Empty title="Nothing matches" hint="Try a different search or clear the filters." icon="∅"><Link className="btn btn-secondary btn-sm" href="/history">Clear the filters</Link></Empty></div>
      ) : (
        <div className="card mt-4 overflow-x-auto p-0">
          <table className="t">
            <thead><tr className="label"><th>When</th><th>What</th><th>Details</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="reveal">
                  <td className="mono" style={{ color: "var(--tx-1)" }}>{when(e.at)}</td>
                  <td><span className="label">{CATEGORY_LABEL[e.category]}</span><div>{e.href ? <Link href={e.href} className="underline">{e.title}</Link> : e.title}</div></td>
                  <td style={{ color: "var(--tx-1)" }}>{e.detail}{e.tx && <div className="mono text-xs break-all" style={{ color: "var(--tx-2)" }}>{e.tx}</div>}</td>
                  <td className={`amount text-right ${e.direction === "in" ? "pos" : ""}`}>{e.direction === "in" ? "+" : "−"}{usd(e.amountUsd)}</td>
                  <td><Badge tone={e.tone}>{e.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default tenantPage(History);
