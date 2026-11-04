import { services } from "./services";
import type { Receivable } from "./types";

const FAILED = new Set(["REFUNDED", "FAILED"]);

/** What a client is told for each 1Click status while they wait on a payment link. */
const NOTE: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit to arrive.",
  PROCESSING: "Your deposit arrived and NEAR Intents is delivering it. This usually takes a minute or two.",
  INCOMPLETE_DEPOSIT: "A deposit arrived but it was less than the amount shown. Send the rest to the same address, or wait for the refund to your refund address.",
  SUCCESS: "Paid. Thank you.",
};

/**
 * Ask 1Click where a payment link's deposit is, and record it. SUCCESS marks the invoice paid. A refunded or failed swap, or
 * a quote that ran out before any deposit, clears the deposit so the client can ask for fresh instructions instead of being
 * stuck on a dead address. Anything in between (processing, a short deposit) is shown as it is.
 */
export async function refreshReceivable(r: Receivable): Promise<{ status: string; note: string }> {
  if (!r.deposit) throw new Error("No payment has been started for this invoice");
  const status = await services.swapStatus(r.deposit.address, r.deposit.memo);
  const checkedAt = new Date().toISOString();
  const expired = status === "PENDING_DEPOSIT" && !!r.deposit.deadline && new Date(r.deposit.deadline) < new Date();
  if (status === "SUCCESS") {
    r.status = "paid";
    r.settlement = { status, checkedAt, note: NOTE.SUCCESS };
  } else if (FAILED.has(status) || expired) {
    const shown = expired ? "EXPIRED" : status;
    const note = expired
      ? "The payment instructions ran out before a deposit arrived. Nothing was taken: ask for new instructions."
      : status === "REFUNDED"
        ? "The payment did not complete and was refunded to your refund address. Ask for new instructions to try again."
        : "The payment could not be completed. Ask for new instructions to try again.";
    r.settlement = { status: shown, checkedAt, note };
    r.deposit = undefined;
  } else {
    r.settlement = { status, checkedAt, note: NOTE[status] ?? `1Click reports: ${status}.` };
  }
  return { status: r.settlement.status, note: r.settlement.note };
}
