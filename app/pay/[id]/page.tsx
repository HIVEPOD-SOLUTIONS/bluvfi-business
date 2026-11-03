import { cfg } from "@/lib/business";
import { notFound } from "next/navigation";
import { tenantPage } from "@/lib/who";
import { bizOfId } from "@/lib/tenant";
import { Logo } from "@/components/Nav";
import { usd } from "@/components/ui";
import { AURORA_API_KEY } from "@/lib/config";
import { state } from "@/lib/store";
import { AuroraPayLoader } from "./AuroraPayLoader";
import { PayWidget } from "./PayWidget";

export const dynamic = "force-dynamic";

async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = state().receivables.find((x) => x.id === id);
  if (!r) notFound();
  return (
    <div className="mx-auto max-w-md pt-4">
      <div className="mb-6"><Logo /></div>
      <div className="card" style={{ borderColor: "var(--bd-sage)" }}>
        <div className="label">Invoice from {cfg().COMPANY_NAME}</div>
        <h1 className="mt-1">{r.client}</h1>
        <p style={{ color: "var(--tx-1)" }}>{r.description}</p>
        <div className="amount mt-4 text-3xl">{usd(r.amountUsd)} <span className="label">USDC</span></div>
        {AURORA_API_KEY && r.status !== "paid" ? (
          <>
            <AuroraPayLoader id={r.id} apiKey={AURORA_API_KEY} payTo={r.payTo} amountUsd={r.amountUsd} />
            <details className="mt-4 text-sm">
              <summary style={{ color: "var(--tx-1)" }}>Or pay manually to a deposit address</summary>
              <PayWidget id={r.id} paid={false} deposit={r.deposit ?? null} />
            </details>
          </>
        ) : (
          <PayWidget id={r.id} paid={r.status === "paid"} deposit={r.deposit ?? null} />
        )}
      </div>
      <p className="mt-4 text-sm" style={{ color: "var(--tx-2)" }}>
        {AURORA_API_KEY
          ? "Connect any wallet and pay with the token you hold. The amount, the currency (USDC on NEAR) and the recipient are fixed by this invoice; NEAR Intents routes and settles it, and refunds your wallet if anything fails."
          : "Pay USDC from any supported chain. The route is quoted live through NEAR Intents on mainnet: send exactly the amount shown to the deposit address from your own wallet, and keep the refund address you enter safe in case anything fails."}
      </p>
    </div>
  );
}

export default tenantPage(PayPage, ({ params }) => params.then(({ id }) => bizOfId(id)));
