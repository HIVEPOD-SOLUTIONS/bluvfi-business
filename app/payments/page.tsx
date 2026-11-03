import { Empty, PageHead, PaymentCard } from "@/components/ui";
import { tenantPage } from "@/lib/who";
import { state } from "@/lib/store";
import { SubmitInvoice } from "./SubmitInvoice";

export const dynamic = "force-dynamic";

function Payments() {
  const { payments, vendors } = state();
  return (
    <>
      <PageHead title="Payments" sub="Every invoice the agent has handled, newest first." />
      {payments.length === 0 ? (
        <Empty title="No payments yet" hint="Add a vendor on the Vendors page, then submit their invoice below." />
      ) : (
        <div className="grid gap-3">{payments.map((p) => <PaymentCard key={p.id} p={p} />)}</div>
      )}
      <SubmitInvoice vendors={vendors.map((v) => ({ name: v.name, domain: v.domain, chain: v.payout.chain, address: v.payout.address }))} />
    </>
  );
}

export default tenantPage(Payments);
