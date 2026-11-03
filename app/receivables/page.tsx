import { Badge, Empty, PageHead, usd, when } from "@/components/ui";
import { tenantPage } from "@/lib/who";
import { state } from "@/lib/store";
import { CopyLink, NewReceivable } from "./Forms";

export const dynamic = "force-dynamic";

function Receivables() {
  const list = state().receivables;
  return (
    <>
      <PageHead title="Receivables" sub="Invoice a client and send them a payment link. They pay from any chain and wallet; the treasury receives USDC through NEAR Intents." />
      <NewReceivable />
      <h2 className="mt-8 mb-3">Invoices you have issued</h2>
      {list.length === 0 ? (
        <Empty title="No invoices yet" hint="Create one above and copy its link." />
      ) : (
        <div className="grid gap-3">
          {list.map((r) => (
            <div key={r.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Badge tone={r.status === "paid" ? "ok" : "warn"}>{r.status === "paid" ? "Paid" : "Waiting for payment"}</Badge>
                  <h2 className="mt-2">{r.client}</h2>
                  <p className="text-sm" style={{ color: "var(--tx-1)" }}>{r.description || "No description"} · issued {when(r.createdAt)}</p>
                </div>
                <div className="amount text-xl">{usd(r.amountUsd)}</div>
              </div>
              <div className="mt-3"><CopyLink path={`/pay/${r.id}`} /></div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default tenantPage(Receivables);
