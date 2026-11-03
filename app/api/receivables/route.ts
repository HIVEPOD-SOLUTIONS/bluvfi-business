
import { cfg } from "@/lib/business";
import { sha256 } from "@/lib/crypto";
import { body, route } from "@/lib/http";
import { state } from "@/lib/store";
import { scopedId } from "@/lib/tenant";

export const POST = route(async (req) => {
  const b = await body<{ client?: string; description?: string; amountUsd?: number }>(req);
  if (!b.client || !b.amountUsd || b.amountUsd <= 0) throw new Error("A client and a positive amount are required");
  if (!cfg().TREASURY_ACCOUNT) throw new Error("TREASURY_ACCOUNT is not set");
  const r = {
    id: scopedId(`rcv-${sha256(b.client + Date.now()).slice(0, 8)}`),
    client: b.client,
    description: b.description ?? "",
    amountUsd: b.amountUsd,
    asset: "USDC",
    chain: "near",
    payTo: cfg().TREASURY_ACCOUNT,
    createdAt: new Date().toISOString(),
    status: "open" as const,
  };
  state().receivables.unshift(r);
  return { receivable: r };
});
