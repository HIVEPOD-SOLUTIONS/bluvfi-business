import { state } from "./store";

/**
 * One history of every money movement of a business, from every place it is kept: invoices it paid, bills, investments, money it received or
 * put in, what the agent spent on APIs and on one-time cards. Built from the business's own records at the moment it is asked for, so it can
 * never disagree with them.
 */
export type HistoryCategory = "payment" | "bill" | "investment" | "banking" | "received" | "funding" | "api" | "card" | "payroll";
export interface HistoryEntry {
  id: string;
  at: string;
  category: HistoryCategory;
  title: string;
  detail: string;
  amountUsd: number;
  direction: "in" | "out";
  /** Plain words: what became of it. */
  status: string;
  tone: "ok" | "warn" | "bad" | "default";
  href?: string;
  tx?: string;
}

export const CATEGORY_LABEL: Record<HistoryCategory, string> = { payment: "Invoice payments", bill: "Bills", investment: "Investments", banking: "Bank cash-outs", received: "Money received", funding: "Funding", api: "API spending", card: "Cards", payroll: "Payroll" };

const PAYMENT_STATUS: Record<string, [string, HistoryEntry["tone"]]> = {
  paid: ["Paid", "ok"], approved: ["Approved", "ok"], ready_to_send: ["Waiting to send", "warn"], proposed: ["Waiting for the council", "warn"],
  awaiting_approval: ["Needs approval", "warn"], held: ["On hold", "warn"], blocked: ["Blocked", "bad"], cancelled: ["Cancelled", "default"],
};
const CARD_STATUS: Record<string, [string, HistoryEntry["tone"]]> = {
  awaiting_approval: ["Needs approval", "warn"], issued: ["Card issued", "ok"], used: ["Used", "ok"], closed: ["Closed", "default"], refused: ["Refused", "bad"], failed: ["Failed", "bad"],
};

export function historyEntries(): HistoryEntry[] {
  const s = state();
  const out: HistoryEntry[] = [];
  for (const p of s.payments) {
    const [status, tone] = PAYMENT_STATUS[p.status] ?? [p.status, "default"];
    const category: HistoryCategory = p.invoice.category === "bill" ? "bill" : p.invoice.category === "investment" ? "investment" : p.invoice.category === "banking" ? "banking" : "payment";
    out.push({
      id: p.id, at: p.createdAt, category, title: p.invoice.vendorName, detail: `${p.invoice.invoiceNumber} · ${p.headline}`,
      amountUsd: p.invoice.amountUsd, direction: "out", status, tone, href: `/payments/${p.id}`, tx: p.custody?.txHash ?? p.txRef,
    });
  }
  for (const r of s.receivables) {
    const funding = r.kind === "funding";
    out.push({
      id: r.id, at: r.settlement?.status === "SUCCESS" ? r.settlement.checkedAt : r.createdAt, category: funding ? "funding" : "received",
      title: funding ? "Put into the treasury" : r.client, detail: r.description || (funding ? "From another chain or token" : "Invoice"),
      amountUsd: r.amountUsd, direction: "in", status: r.status === "paid" ? "Received" : "Waiting for the deposit", tone: r.status === "paid" ? "ok" : "warn", href: `/pay/${r.id}`,
    });
  }
  for (const [i, x] of s.x402Spend.entries()) {
    let host = x.url;
    try { host = new URL(x.url).host; } catch { /* keep the raw text */ }
    out.push({ id: `x402-${i}-${x.at}`, at: x.at, category: "api", title: host, detail: "Paid for an API call (x402)", amountUsd: x.priceUsd, direction: "out", status: "Paid", tone: "ok" });
  }
  const PAYROLL: Record<string, [string, HistoryEntry["tone"]]> = {
    ready: ["Not sent yet", "default"], blocked: ["Blocked", "bad"], proposed: ["Waiting for the council", "warn"], sent: ["On its way", "warn"],
    paid: ["Paid", "ok"], refunded: ["Refunded", "default"], failed: ["Failed", "bad"], expired: ["Expired", "bad"], rejected: ["Rejected", "default"],
  };
  for (const run of s.payrollRuns ?? []) {
    if (run.status === "draft" || run.status === "cancelled") continue;
    for (const r of run.rows) {
      const [status, tone] = PAYROLL[r.status] ?? [r.status, "default"];
      out.push({ id: `${run.id}-${r.line}`, at: run.sentAt ?? run.createdAt, category: "payroll", title: r.name, detail: `${run.title} · ${r.asset} on ${r.chain}`, amountUsd: r.amountUsd, direction: "out", status, tone, href: "/payroll" });
    }
  }
  for (const c of s.cardPurchases ?? []) {
    const [status, tone] = CARD_STATUS[c.status] ?? [c.status, "default"];
    out.push({ id: c.id, at: c.createdAt, category: "card", title: c.merchant, detail: c.reason, amountUsd: c.amountUsd, direction: "out", status, tone, href: "/cards" });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface HistoryFilter { category?: string; q?: string; from?: string; to?: string; status?: string }

export function filterHistory(all: HistoryEntry[], f: HistoryFilter): HistoryEntry[] {
  const q = f.q?.trim().toLowerCase();
  const from = f.from ? Date.parse(f.from) : NaN;
  const to = f.to ? Date.parse(f.to) + 86_400_000 : NaN; // the whole of the last day
  return all.filter((e) =>
    (!f.category || e.category === f.category) &&
    (!f.status || e.tone === f.status) &&
    (!q || `${e.title} ${e.detail} ${e.status} ${e.tx ?? ""}`.toLowerCase().includes(q)) &&
    (Number.isNaN(from) || Date.parse(e.at) >= from) &&
    (Number.isNaN(to) || Date.parse(e.at) < to));
}

const csvCell = (v: unknown) => {
  const t = String(v ?? "");
  // A spreadsheet runs a cell that starts with = + - or @ as a formula: neutralise that.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function historyCsv(rows: HistoryEntry[]): string {
  const head = ["When", "Category", "Title", "Detail", "Direction", "Amount (USD)", "Status", "Transaction"];
  return [head, ...rows.map((e) => [e.at, CATEGORY_LABEL[e.category], e.title, e.detail, e.direction === "in" ? "In" : "Out", e.amountUsd.toFixed(2), e.status, e.tx ?? ""])].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
