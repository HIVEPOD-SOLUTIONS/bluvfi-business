import Link from "next/link";
import { cfg } from "@/lib/business";
import { Badge, PageHead, usd, when } from "@/components/ui";
import { FundPanel } from "@/components/FundPanel";
import { PRIVY_APP_ID } from "@/lib/config";
import { state } from "@/lib/store";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function Fund() {
  const account = cfg().TREASURY_ACCOUNT;
  const links = state().receivables.filter((r) => r.kind === "funding").slice(0, 8);
  return (
    <>
      <PageHead title="Fund the treasury" sub="Add money to the business's treasury. It goes straight into the treasury account, which only the council can spend from." />
      <FundPanel account={account} ready={!!account} privyAppId={PRIVY_APP_ID} />
      {links.length > 0 && (
        <>
          <h2 className="mt-8 mb-3">Your funding links</h2>
          <div className="grid gap-2">
            {links.map((r) => (
              <Link key={r.id} href={`/pay/${r.id}`} className="card flex flex-wrap items-center justify-between gap-3">
                <div><span className="amount">{usd(r.amountUsd)}</span> <span className="text-sm" style={{ color: "var(--tx-2)" }}>· {when(r.createdAt)}</span></div>
                <Badge tone={r.status === "paid" ? "ok" : "warn"} live={r.status !== "paid"}>{r.status === "paid" ? "Received" : "Waiting for the deposit"}</Badge>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default tenantPage(Fund);
