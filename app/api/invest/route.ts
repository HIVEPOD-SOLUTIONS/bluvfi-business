import { missingHere } from "@/lib/business";
import { body, route } from "@/lib/http";
import { holdings, listAssets, orderAllocation, previewAllocation } from "@/lib/invest";
import { requireSigner } from "@/lib/session";
import { currentPolicy } from "@/lib/store";
import type { Confidentiality } from "@/lib/types";

/**
 * Investing for the signed-in business. GET gives the coins on offer, what the council allows, and what the treasury holds. POST {preview} asks
 * what an amount would buy; POST {symbol, amountUsd} proposes the investment (a payment the council's rules and the treasury still decide).
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  const p = currentPolicy();
  const [assets, held] = await Promise.all([listAssets(), holdings().catch(() => [])]);
  return { assets, holdings: held, allowed: { assets: p.investAssets ?? [], maxUsd: p.investMaxUsd ?? 0 } };
});

export const POST = route(async (req) => {
  await requireSigner(req);
  const b = await body<{ symbol?: string; amountUsd?: number; preview?: boolean; confidentiality?: Confidentiality }>(req);
  const symbol = String(b.symbol ?? "").toUpperCase();
  const amount = Number(b.amountUsd);
  if (!symbol || !Number.isFinite(amount)) throw new Error("Choose a coin and an amount");
  if (b.preview) return { preview: await previewAllocation(symbol, amount) };
  const blocking = missingHere().filter((m) => m.key === "BLUVFI_MASTER_KEY" || m.key === "TREASURY_ACCOUNT");
  if (blocking.length) throw new Error(`Setup incomplete: ${blocking.map((m) => m.key).join(", ")}`);
  const conf: Confidentiality = b.confidentiality === "public" || b.confidentiality === "advanced" ? b.confidentiality : "basic";
  return await orderAllocation({ symbol, amountUsd: amount, confidentiality: conf });
});
