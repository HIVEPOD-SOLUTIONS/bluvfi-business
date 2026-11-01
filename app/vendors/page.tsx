import { Badge, Empty, PageHead, when } from "@/components/ui";
import { CHAIN_LABEL } from "@/lib/chains";
import { currentPolicy, state } from "@/lib/store";
import { NewPurchaseOrder, NewVendor } from "./Forms";

export const dynamic = "force-dynamic";

export default function Vendors() {
  const s = state();
  const allow = currentPolicy().vendorAllowlist;
  return (
    <>
      <PageHead
        title="Vendors"
        sub="Who you pay, where they get paid, and the channel you already trust for confirming changes. The agent compares every invoice against this record."
      />
      <NewVendor />
      <h2 className="mt-8 mb-3">Vendor records</h2>
      {s.vendors.length === 0 ? (
        <Empty title="No vendors yet" hint="Add the vendors you pay. Invoices from unknown vendors are always held for a human." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {s.vendors.map((v) => (
            <div key={v.name} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2>{v.name}</h2>
                <Badge tone={allow.includes(v.name) ? "ok" : "warn"}>{allow.includes(v.name) ? "On allowlist" : "Not on allowlist"}</Badge>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt style={{ color: "var(--tx-2)" }}>Domain</dt><dd>{v.domain}</dd>
                <dt style={{ color: "var(--tx-2)" }}>Pays to</dt><dd className="mono break-all">{v.payout.address} ({CHAIN_LABEL[v.payout.chain] ?? v.payout.chain}, {v.payout.asset})</dd>
                <dt style={{ color: "var(--tx-2)" }}>Verified contact</dt><dd className="break-all">{v.verifiedContact.channel}: {v.verifiedContact.handle}</dd>
                <dt style={{ color: "var(--tx-2)" }}>Last paid</dt><dd>{v.lastPaidAt ? when(v.lastPaidAt) : "Never"}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}

      <h2 className="mt-8 mb-3">Purchase orders</h2>
      <NewPurchaseOrder vendors={s.vendors.map((v) => v.name)} />
      {s.purchaseOrders.length > 0 && (
        <div className="card mt-3 overflow-x-auto">
          <table className="t">
            <thead><tr className="label"><th>PO</th><th>Vendor</th><th>Amount</th></tr></thead>
            <tbody>
              {s.purchaseOrders.map((p) => (
                <tr key={p.po}><td className="mono">{p.po}</td><td>{p.vendorName}</td><td className="amount">${p.amountUsd.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
