import Link from "next/link";
import { BillsPanel, CheckBill, Countdown } from "@/components/BillsPanel";
import { Badge, Empty, PageHead, usd, when } from "@/components/ui";
import { cryptorefillsConfigured } from "@/lib/cryptorefills";
import { state } from "@/lib/store";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

const TONE: Record<string, "ok" | "warn" | "bad" | "default"> = { complete: "ok", payment_confirmed: "ok", payment_detected: "warn", pending: "warn", unpaid: "warn", denied: "bad", failed: "bad", expired: "bad" };
const WORDS: Record<string, string> = { unpaid: "Waiting for payment", payment_detected: "Payment seen", payment_confirmed: "Payment confirmed", pending: "Being delivered", complete: "Delivered: check the email", denied: "Refused", failed: "Failed", expired: "Order expired" };

async function Bills() {
  const bills = state().payments.filter((p) => p.bill && p.bill.provider !== "credible");
  return (
    <>
      <PageHead title="Pay bills" sub="Gift cards, phone top-ups and eSIM data, bought through Bitrefill (no account) or Cryptorefills. Every order is checked against your rules and approved by your treasury, like any payment." />
      <BillsPanel cryptorefillsOn={cryptorefillsConfigured()} />
      <h2 className="mt-8 mb-3">Your bills</h2>
      {bills.length === 0 ? (
        <Empty title="No bills yet" hint="Search above, choose a size and order. It shows up here with where it stands." icon="▦" />
      ) : (
        <div className="grid gap-3">
          {bills.map((p) => {
            const b = p.bill!;
            const open = !["complete", "denied", "failed", "expired"].includes(b.status) && p.status !== "paid" && p.status !== "cancelled" && p.status !== "blocked";
            return (
              <div key={p.id} className="card flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><strong>{b.product}</strong><span className="amount">{usd(p.invoice.amountUsd)}</span></div>
                  <div className="text-sm" style={{ color: "var(--tx-1)" }}>{p.headline} · {when(p.createdAt)} · receipt to {b.email}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {open && <Countdown until={b.expiresAt} />}
                  <Badge tone={TONE[b.status] ?? "default"} live={open || b.status === "pending"}>{WORDS[b.status] ?? b.status}</Badge>
                  {p.status === "paid" && b.status !== "complete" && <CheckBill paymentId={p.id} />}
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

export default tenantPage(Bills);
