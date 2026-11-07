import Link from "next/link";
import { BankPanel } from "@/components/BankPanel";
import { Countdown } from "@/components/BillsPanel";
import { Badge, Empty, PageHead, usd, when } from "@/components/ui";
import { state } from "@/lib/store";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

const TONE: Record<string, "ok" | "warn" | "bad" | "default"> = { complete: "ok", pending: "warn", unpaid: "warn", failed: "bad", expired: "bad" };
const WORDS: Record<string, string> = { unpaid: "Waiting for your USDC", pending: "Credible is paying the rupees", complete: "Rupees sent", failed: "Failed", expired: "Order expired" };
const ON_WORDS: Record<string, string> = { CREATED: "Waiting for your UPI payment", PAYMENT_PENDING: "Payment pending", PAYMENT_RECEIVED: "Payment received", WITHDRAWAL_INITIATED: "USDC on its way", CONFIRMATIONS_PENDING: "USDC on its way", COMPLETED: "USDC sent", EXPIRED: "Expired", FAILED: "Failed" };

async function Banking() {
  const outs = state().payments.filter((p) => p.bill?.provider === "credible");
  const ins = state().receivables.filter((r) => r.bank);
  return (
    <>
      <PageHead title="Bank transfers" sub="Add money by UPI and cash out to an Indian bank account, in rupees, through your own Credible Finance account. Money in lands in the treasury through NEAR Intents; money out is a USDC payment your rules and your treasury approve." />
      <BankPanel />
      <h2 className="mt-8 mb-3">Your transfers</h2>
      {outs.length === 0 && ins.length === 0 ? (
        <Empty title="No bank transfers yet" hint="Add money or cash out above. It shows up here with where it stands." icon="₹" />
      ) : (
        <div className="grid gap-3">
          {ins.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>Added by UPI</strong><span className="amount">₹{r.bank!.inr.toLocaleString("en-IN")}</span></div><div className="text-sm" style={{ color: "var(--tx-1)" }}>{usd(r.amountUsd)} into the treasury · {when(r.createdAt)}</div></div>
              <div className="flex flex-wrap items-center gap-2">
                {r.status === "open" && <Countdown until={r.bank!.expiresAt} />}
                <Badge tone={r.status === "paid" ? "ok" : "warn"} live={r.status === "open"}>{r.status === "paid" ? "In the treasury" : ON_WORDS[r.bank!.status] ?? r.bank!.status}</Badge>
                <Link className="btn btn-secondary btn-sm" href={`/pay/${r.id}`}>Open</Link>
              </div>
            </div>
          ))}
          {outs.map((p) => {
            const b = p.bill!;
            const open = !["complete", "failed", "expired"].includes(b.status) && p.status !== "paid" && p.status !== "cancelled" && p.status !== "blocked";
            return (
              <div key={p.id} className="card flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong>{b.product}</strong><span className="amount">{usd(p.invoice.amountUsd)}</span></div><div className="text-sm" style={{ color: "var(--tx-1)" }}>{p.headline} · {when(p.createdAt)}</div></div>
                <div className="flex flex-wrap items-center gap-2">
                  {open && <Countdown until={b.expiresAt} />}
                  <Badge tone={TONE[b.status] ?? "default"} live={open || b.status === "pending"}>{WORDS[b.status] ?? b.status}</Badge>
                  <Link className="btn btn-secondary btn-sm" href={`/payments/${p.id}`}>{open ? "Approve it" : "Open"}</Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default tenantPage(Banking);
