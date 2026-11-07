import { missingHere } from "@/lib/business";
import { mustFind } from "@/lib/agent";
import { addBankAccount, bankingConfigured, cashOut, listBankAccounts, offrampPairs, onrampPairs, quoteOfframp, quoteOnramp, refreshCashOut, refreshOnramp, startOnramp } from "@/lib/banking";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { state } from "@/lib/store";
import type { Confidentiality } from "@/lib/types";

/**
 * INR bank transfers for the signed-in business, through its own Credible Finance account.
 *  GET            what is connected, and the pairs and saved bank accounts when it is.
 *  GET ?quote=on|off&pair=…&amount=…   what an amount buys or pays, before anything starts.
 *  POST {action:"add"}      start an INR (UPI) payment that becomes USDC in the treasury.
 *  POST {action:"cashout"}  create a cash-out: a payment of USDC that the policy and the treasury still decide.
 *  POST {action:"account"}  save a bank account with Credible (it keeps the number, not us).
 *  POST {refresh}           ask where an order stands.
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  if (!bankingConfigured()) return { configured: false };
  const u = new URL(req.url).searchParams;
  if (u.get("quote") === "on") return await quoteOnramp(u.get("pair") ?? "", Number(u.get("amount")));
  if (u.get("quote") === "off") return await quoteOfframp(u.get("pair") ?? "", Number(u.get("amount")));
  const [on, off, accounts] = await Promise.all([onrampPairs(), offrampPairs(), listBankAccounts()]);
  return { configured: true, on, off, accounts };
});

export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ action?: string; refresh?: string; pairId?: string; amountInr?: number; amountUsdc?: number; firstName?: string; lastName?: string; refundTo?: string; bankAccountId?: string; accountNumber?: string; ifsc?: string; confidentiality?: Confidentiality }>(req);
  if (b.refresh) {
    const id = String(b.refresh);
    const r = state().receivables.find((x) => x.id === id);
    if (r) return { bank: await refreshOnramp(r) };
    return { bill: await refreshCashOut(mustFind(id)) };
  }
  if (b.action === "account") return { account: await addBankAccount({ firstName: b.firstName ?? "", lastName: b.lastName ?? "", accountNumber: b.accountNumber ?? "", ifsc: b.ifsc ?? "" }) };
  const blocking = missingHere().filter((m) => m.key === "BLUVFI_MASTER_KEY" || m.key === "TREASURY_ACCOUNT");
  if (blocking.length) throw new Error(`Setup incomplete: ${blocking.map((m) => m.key).join(", ")}`);
  if (b.action === "add") return { receivable: await startOnramp({ pairId: b.pairId ?? "", amountInr: Number(b.amountInr), firstName: b.firstName ?? "", lastName: b.lastName ?? "", refundTo: (b.refundTo ?? "").trim() }) };
  if (b.action === "cashout") {
    const conf: Confidentiality = b.confidentiality === "public" || b.confidentiality === "advanced" ? b.confidentiality : "basic";
    const payment = await cashOut({ pairId: b.pairId ?? "", amountUsdc: Number(b.amountUsdc), bankAccountId: b.bankAccountId ?? "", firstName: b.firstName ?? "", lastName: b.lastName ?? "", confidentiality: conf });
    return { payment, orderedBy: by };
  }
  throw new Error("Unknown action");
});
