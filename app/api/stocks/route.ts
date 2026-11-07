import { missingHere } from "@/lib/business";
import { account, depositAddress, fundAccount, listStocks, stockChart, stocksConfigured, trade } from "@/lib/stocks";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import type { Confidentiality } from "@/lib/types";

/**
 * US stocks and ETFs through the signed-in business's own Backpack account.
 *  GET                 the list with prices (public), and whether an account is connected.
 *  GET ?chart=AAPL.US&days=30   price history.
 *  GET ?account=1      what the account holds (needs its keys).
 *  POST {action:"fund"}   propose a USDC payment to the account's deposit address: the rules and the council decide it.
 *  POST {action:"trade"}  buy or sell, capped by the council's rule for one investment.
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  const u = new URL(req.url).searchParams;
  if (u.get("chart")) return await stockChart(u.get("chart")!, Number(u.get("days")) || 30);
  if (u.get("account")) return { ...(await account()), deposit: await depositAddress() };
  return { configured: stocksConfigured(), stocks: await listStocks() };
});

export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ action?: string; amountUsd?: number; asset?: string; side?: string; confidentiality?: Confidentiality }>(req);
  if (b.action === "fund") {
    const blocking = missingHere().filter((m) => m.key === "BLUVFI_MASTER_KEY" || m.key === "TREASURY_ACCOUNT");
    if (blocking.length) throw new Error(`Setup incomplete: ${blocking.map((m) => m.key).join(", ")}`);
    const conf: Confidentiality = b.confidentiality === "public" || b.confidentiality === "advanced" ? b.confidentiality : "basic";
    return { payment: await fundAccount({ amountUsd: Number(b.amountUsd), confidentiality: conf }), orderedBy: by };
  }
  if (b.action === "trade") {
    if (b.side !== "buy" && b.side !== "sell") throw new Error("Choose buy or sell");
    return { trade: await trade({ asset: String(b.asset ?? ""), side: b.side, amountUsd: Number(b.amountUsd) }), by };
  }
  throw new Error("Unknown action");
});
