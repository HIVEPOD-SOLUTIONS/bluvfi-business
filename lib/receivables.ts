import { services } from "./services";
import type { Receivable } from "./types";

const FAILED = new Set(["REFUNDED", "FAILED"]);
type Deposit = NonNullable<Receivable["deposit"]>;

/** What a client is told for each 1Click status while they wait on a payment link. */
const NOTE: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit to arrive.",
  PROCESSING: "Your deposit arrived and NEAR Intents is delivering it. This usually takes a minute or two.",
  INCOMPLETE_DEPOSIT: "A deposit arrived but it was less than the amount shown. Send the rest to the same address, or wait for the refund to your refund address.",
  SUCCESS: "Paid. Thank you.",
};

/**
 * Give a payment link a new deposit address. The one it had stays tracked (in `earlier`) until it is paid, refunded or
 * expires: someone may already have sent money to it, and asking for new instructions must never make that payment
 * go unnoticed. At most 25 are kept; the oldest are dropped first.
 */
export function addDeposit(r: Receivable, d: Deposit) {
  if (r.deposit) r.earlier = [r.deposit, ...(r.earlier ?? [])].slice(0, 25);
  r.deposit = d;
}

/**
 * Ask 1Click where a payment link's deposits are, and record it. Any deposit that succeeded marks the link paid. A refunded or
 * failed swap, or a quote that ran out before any deposit, is dropped so the client can ask for fresh instructions instead of
 * being stuck on a dead address. Anything in between (processing, a short deposit) is shown as it is.
 */
export async function refreshReceivable(r: Receivable): Promise<{ status: string; note: string }> {
  if (!r.deposit && !r.earlier?.length) throw new Error("No payment has been started for this invoice");
  const checkedAt = new Date().toISOString();
  const all = [...(r.deposit ? [r.deposit] : []), ...(r.earlier ?? [])];
  const seen: { d: Deposit; status: string; dead: boolean }[] = [];
  for (const d of all) {
    const status = await services.swapStatus(d.address, d.memo);
    const expired = status === "PENDING_DEPOSIT" && !!d.deadline && new Date(d.deadline) < new Date();
    seen.push({ d, status, dead: FAILED.has(status) || expired });
    if (status === "SUCCESS") {
      r.status = "paid";
      r.settlement = { status, checkedAt, note: NOTE.SUCCESS };
      return { status, note: NOTE.SUCCESS };
    }
  }
  const current = seen[0] && r.deposit && seen[0].d === r.deposit ? seen[0] : undefined;
  r.earlier = seen.filter((x) => x !== current && !x.dead).map((x) => x.d);
  if (!r.earlier.length) delete r.earlier;
  if (current?.dead || !current) {
    const status = current ? (FAILED.has(current.status) ? current.status : "EXPIRED") : "EXPIRED";
    const note = status === "EXPIRED"
      ? "The payment instructions ran out before a deposit arrived. Nothing was taken: ask for new instructions."
      : status === "REFUNDED"
        ? "The payment did not complete and was refunded to your refund address. Ask for new instructions to try again."
        : "The payment could not be completed. Ask for new instructions to try again.";
    if (current) r.deposit = undefined;
    r.settlement = { status, checkedAt, note };
  } else {
    r.settlement = { status: current.status, checkedAt, note: NOTE[current.status] ?? `1Click reports: ${current.status}.` };
  }
  return { status: r.settlement.status, note: r.settlement.note };
}
