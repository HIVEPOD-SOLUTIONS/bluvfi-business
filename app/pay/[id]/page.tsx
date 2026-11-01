import { notFound } from "next/navigation";
import { Logo } from "@/components/Nav";
import { usd } from "@/components/ui";
import { COMPANY_NAME } from "@/lib/config";
import { state } from "@/lib/store";
import { PayWidget } from "./PayWidget";

export const dynamic = "force-dynamic";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = state().receivables.find((x) => x.id === id);
  if (!r) notFound();
  return (
    <div className="mx-auto max-w-md pt-4">
      <div className="mb-6"><Logo /></div>
      <div className="card" style={{ borderColor: "var(--bd-sage)" }}>
        <div className="label">Invoice from {COMPANY_NAME}</div>
        <h1 className="mt-1">{r.client}</h1>
        <p style={{ color: "var(--tx-1)" }}>{r.description}</p>
        <div className="amount mt-4 text-3xl">{usd(r.amountUsd)} <span className="label">USDC</span></div>
        <PayWidget id={r.id} paid={r.status === "paid"} deposit={r.deposit ?? null} />
      </div>
      <p className="mt-4 text-sm" style={{ color: "var(--tx-2)" }}>
        Pay USDC from any supported chain. The route is quoted live through NEAR Intents on mainnet: send exactly the amount shown to the deposit address from your own wallet, and keep the refund address you enter safe in case anything fails.
      </p>
    </div>
  );
}
