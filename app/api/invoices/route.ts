import { processInvoice } from "@/lib/agent";
import { missingConfig } from "@/lib/config";
import { body, route } from "@/lib/http";
import type { Confidentiality, Invoice } from "@/lib/types";

export const POST = route(async (req) => {
  const b = await body<{ invoice?: Partial<Invoice>; confidentiality?: Confidentiality }>(req);
  const i = b.invoice;
  if (!i?.vendorName || !i.invoiceNumber || !i.payoutAddress || !i.chain || !i.asset || !i.text) throw new Error("vendorName, invoiceNumber, payoutAddress, chain, asset and text are required");
  if (!Number.isFinite(i.amountUsd) || (i.amountUsd as number) <= 0) throw new Error("amountUsd must be a positive number");
  const blocking = missingConfig().filter((m) => m.key === "PROOFPAY_MASTER_KEY" || m.key === "TREASURY_ACCOUNT");
  if (blocking.length) throw new Error(`Setup incomplete: ${blocking.map((m) => m.key).join(", ")}`);
  const conf: Confidentiality = b.confidentiality === "public" || b.confidentiality === "advanced" ? b.confidentiality : "basic";
  const inv: Invoice = {
    id: `inv-${Date.now()}`,
    vendorName: i.vendorName,
    vendorDomain: i.vendorDomain ?? "",
    vendorContact: i.vendorContact ?? { channel: "email", handle: "" },
    invoiceNumber: i.invoiceNumber,
    poNumber: i.poNumber ?? "",
    amountUsd: i.amountUsd as number,
    asset: i.asset,
    chain: i.chain,
    payoutAddress: i.payoutAddress.trim(),
    text: i.text,
    receivedAt: new Date().toISOString(),
  };
  return { payment: await processInvoice(inv, conf) };
});
