import { createHmac, timingSafeEqual } from "node:crypto";
import type { CardSecrets } from "./card-providers";
import { businesses, cfg } from "./business";
import { CARD_TTL_HOURS } from "./config";
import { sha256 } from "./crypto";
import { services } from "./services";
import { currentPolicy, persist, spentTodayUsd, state, withRecords } from "./store";
import { approvalThreshold } from "./team";
import { DEFAULT_BIZ, runAs } from "./tenant";
import type { CardPurchase } from "./types";

export type { CardSecrets };

/**
 * One-time cards for the agent. Plenty of what an agent needs to buy (a domain, a SaaS seat, a dataset) sits behind an ordinary card
 * checkout, not an x402 paywall or a crypto address. For each purchase the agent asks for a virtual card made for that one purchase:
 *  - the council's policy decides first: the kill switch, a daily card budget (cardDailyLimitUsd), the per-payment limit, the overall
 *    daily limit, the blocklist, and an OFAC screen of the merchant's name; from the approval threshold up, signers must approve;
 *  - the card is capped at the purchase's amount by the card issuer itself, so even a leaked number cannot be charged more;
 *  - with Stripe, every charge is also approved or declined here in real time: only the first charge, only up to the amount, only
 *    while the card is fresh and the kill switch is off;
 *  - the card number is handed over once, when the card is made, and never stored: only the last four digits are kept;
 *  - an unused card is closed after CARD_TTL_HOURS, and the kill switch closes every open card.
 * Providers: Stripe Issuing, Ramp's Vault API (Agent Cards) and Rain (cards backed by stablecoin collateral). Built to each provider's
 * documentation; tested against local servers that speak their APIs.
 */

// ---------- The agent's side: policy first, then a card ----------

/** Dollars as people write them: $42.50, $5,000. */
const money = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const uid = () => `card-${sha256(`${Date.now()}${Math.random()}`).slice(0, 8)}`;
export const purchases = (): CardPurchase[] => (state().cardPurchases ??= []);
const find = (id: string) => {
  const p = purchases().find((x) => x.id === id);
  if (!p) throw new Error("Card purchase not found");
  return p;
};

/** Put on cards today: everything asked for today that was not refused, at its full amount, so parallel requests cannot pass the budget. */
export function cardSpentTodayUsd(except?: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return purchases().filter((p) => p.id !== except && p.createdAt.startsWith(today) && p.status !== "refused" && p.status !== "failed").reduce((s, p) => s + p.amountUsd, 0);
}

export const cardsAvailable = () => !!services.cardProvider();

/** The policy's answer for a purchase: refused (and why), or allowed with or without signers. */
async function decide(p: CardPurchase): Promise<{ refuse?: string; approvalBecause?: string }> {
  const policy = currentPolicy();
  const s = state();
  if (s.killSwitch) return { refuse: "The kill switch is on. No cards are issued." };
  const budget = policy.cardDailyLimitUsd ?? 0;
  if (budget <= 0) return { refuse: "The policy gives the agent no card budget (Policy: card spend per day)." };
  if (p.amountUsd > policy.perPaymentLimitUsd) return { refuse: `${money(p.amountUsd)} is over the per-payment limit of ${money(policy.perPaymentLimitUsd)}.` };
  const cardsToday = cardSpentTodayUsd(p.id);
  if (cardsToday + p.amountUsd > budget) return { refuse: `${money(p.amountUsd)} would take today's card spending past the policy's ${money(budget)} (already ${money(cardsToday)}).` };
  if (spentTodayUsd() + cardsToday + p.amountUsd > policy.dailyLimitUsd) return { refuse: `${money(p.amountUsd)} would take today's total spending past the daily limit of ${money(policy.dailyLimitUsd)}.` };
  if (p.merchantUrl) {
    const host = new URL(p.merchantUrl).hostname.toLowerCase();
    const hit = s.blocklist.find((b) => b.kind === "domain" && (host === b.value.toLowerCase() || host.endsWith(`.${b.value.toLowerCase()}`)));
    if (hit) return { refuse: `${host} is on the blocklist: ${hit.reason}` };
  }
  let approvalBecause: string | undefined;
  try {
    const sc = await services.screenSanctions({ name: p.merchant });
    if (sc.status === "hit" && sc.hits.some((h) => h.exact)) return { refuse: `The merchant's name matches an OFAC listing: ${sc.hits.find((h) => h.exact)!.detail}.` };
    if (sc.status === "hit") approvalBecause = `the merchant's name is close to an OFAC listing (${sc.hits[0].detail})`;
    if (sc.status === "unavailable") approvalBecause = "the merchant could not be screened against the OFAC list";
  } catch {
    approvalBecause = "the merchant could not be screened against the OFAC list";
  }
  if (p.amountUsd >= policy.approvalThresholdUsd) approvalBecause = `${money(p.amountUsd)} is at or above the approval threshold of ${money(policy.approvalThresholdUsd)}`;
  return { approvalBecause };
}

async function issue(p: CardPurchase): Promise<CardSecrets | undefined> {
  const provider = services.cardProvider();
  if (!provider) throw new Error("No card provider is set up");
  try {
    const card = await provider.issue({ purchaseId: p.id, merchant: p.merchant, amountUsd: p.amountUsd });
    Object.assign(p, { status: "issued", provider: provider.id, cardId: card.cardId, closeRef: card.closeRef, last4: card.last4, expiresAt: new Date(Date.now() + CARD_TTL_HOURS * 3_600_000).toISOString() });
    p.note = `${provider.name} card ending ${card.last4}, capped at ${money(p.amountUsd)}, closes ${CARD_TTL_HOURS} h from now if unused. Its number is shown once.`;
    return card.secrets;
  } catch (e) {
    p.status = "failed";
    p.note = (e as Error).message;
    return undefined;
  }
}

export interface PurchaseInput { merchant?: string; merchantUrl?: string; amountUsd?: number; reason?: string }

/** The agent asks for a card for one purchase. Returns the card's details once, if it was issued now. */
export async function requestCardPurchase(input: PurchaseInput, by: string): Promise<{ purchase: CardPurchase; card?: CardSecrets }> {
  // Each business's cards come from its own card-issuing account (Settings page), so they are charged to it and to nobody else.
  if (!services.cardProvider()) throw new Error("This business has no card provider set up. An owner connects Stripe, Ramp or Rain on the Settings page.");
  const merchant = String(input.merchant ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const amountUsd = Math.round(Number(input.amountUsd) * 100) / 100;
  if (!merchant || merchant.length > 120) throw new Error("Name the merchant (at most 120 characters).");
  if (!reason || reason.length > 500) throw new Error("Say what the purchase is for (at most 500 characters).");
  if (!(amountUsd > 0) || amountUsd > 1_000_000) throw new Error("Give the most the purchase may cost, in USD, tax and shipping included.");
  let merchantUrl: string | undefined;
  if (input.merchantUrl) {
    if (!/^https:\/\//.test(input.merchantUrl)) throw new Error("The merchant's address must start with https://");
    merchantUrl = new URL(input.merchantUrl).toString();
  }
  const p: CardPurchase = { id: uid(), merchant, merchantUrl, amountUsd, reason, requestedBy: by, createdAt: new Date().toISOString(), status: "awaiting_approval", approvals: [], authorizations: [], note: "" };
  purchases().unshift(p);
  const d = await decide(p);
  if (d.refuse) {
    p.status = "refused";
    p.note = d.refuse;
    return { purchase: p };
  }
  if (d.approvalBecause) {
    p.needsApprovalBecause = d.approvalBecause;
    p.note = `Waiting for ${approvalThreshold()} signer approval(s): ${d.approvalBecause}.`;
    return { purchase: p };
  }
  const card = await issue(p);
  return { purchase: p, card };
}

/** A signer approves a purchase that needed approval. The approval that completes it gets the card's details, once. */
export async function approveCardPurchase(id: string, signer: string): Promise<{ purchase: CardPurchase; card?: CardSecrets }> {
  const p = find(id);
  if (p.status !== "awaiting_approval") throw new Error("This purchase is not waiting for approval");
  if (!p.approvals.includes(signer)) p.approvals.push(signer);
  if (p.approvals.length < approvalThreshold()) {
    p.note = `Approved by ${p.approvals.join(", ")}; ${approvalThreshold() - p.approvals.length} more needed.`;
    return { purchase: p };
  }
  // The policy is checked again: the kill switch or today's spending may have changed while it waited.
  const d = await decide(p);
  if (d.refuse) {
    p.status = "refused";
    p.note = d.refuse;
    return { purchase: p };
  }
  const card = await issue(p);
  return { purchase: p, card };
}

/** Close a purchase's card (or turn down one still waiting). */
export async function closeCardPurchase(id: string, why = "closed by a signer"): Promise<CardPurchase> {
  const p = find(id);
  if (p.status === "awaiting_approval") {
    Object.assign(p, { status: "refused", note: `Turned down: ${why}.` });
    return p;
  }
  if (p.status !== "issued" && p.status !== "used") return p;
  const provider = services.cardProvider();
  if (!provider || !p.cardId) throw new Error("The card's provider is not set up here, so the card cannot be closed from here");
  await provider.close(p.cardId, p.closeRef);
  // The charges stay in `authorizations`; the note now only says the card is gone.
  Object.assign(p, { status: "closed", closedAt: new Date().toISOString(), note: `Card ending ${p.last4 ?? "?"} closed: ${why}.` });
  return p;
}

/** Close every open card: unused ones past their time, or all of them (the kill switch). Failures are reported, not thrown. */
export async function closeOpenCards(opts: { all?: boolean; now?: number; why?: string } = {}): Promise<{ closed: string[]; failed: { id: string; error: string }[] }> {
  const now = opts.now ?? Date.now();
  const out = { closed: [] as string[], failed: [] as { id: string; error: string }[] };
  for (const p of purchases()) {
    if (p.status !== "issued" && p.status !== "used") continue;
    if (!opts.all && !(p.expiresAt && Date.parse(p.expiresAt) <= now)) continue;
    try {
      await closeCardPurchase(p.id, opts.why ?? (p.status === "used" ? "used, and its time is up" : "not used in time"));
      out.closed.push(p.id);
    } catch (e) {
      out.failed.push({ id: p.id, error: (e as Error).message });
    }
  }
  if (out.closed.length) persist();
  return out;
}

/** The scheduled sweep: close cards whose time is up, in every business, each with its own provider. */
export async function closeOpenCardsEverywhere(): Promise<Record<string, Awaited<ReturnType<typeof closeOpenCards>>>> {
  const ids = [DEFAULT_BIZ, ...businesses().map((b) => b.id).filter((id) => id !== DEFAULT_BIZ)];
  const out: Record<string, Awaited<ReturnType<typeof closeOpenCards>>> = {};
  for (const id of ids) {
    const r = await runAs(id, () => withRecords(() => closeOpenCards()));
    if (r.closed.length || r.failed.length) out[id] = r;
  }
  return out;
}

// ---------- Stripe real-time authorizations: every charge on a card is decided here ----------

/** Stripe's webhook signature: `t=<time>,v1=<hex HMAC-SHA256 of "<time>.<body>">`, within five minutes. */
export function stripeSignatureValid(raw: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((x) => x.split("=") as [string, string]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return parts.some(([k, v]) => k === "v1" && !!v && v.length === want.length && timingSafeEqual(Buffer.from(v), Buffer.from(want)));
}

interface StripeAuthorization {
  id?: string;
  card?: { id?: string } | string;
  pending_request?: { amount?: number; currency?: string } | null;
  amount?: number;
  currency?: string;
  approved?: boolean;
  merchant_data?: { name?: string; category?: string; url?: string };
}

/** Approve or decline one charge: only on a card we issued, still fresh, never used, kill switch off, and within its amount. */
export function decideAuthorization(a: StripeAuthorization, now = Date.now()): { approved: boolean; reason: string } {
  const cardId = typeof a.card === "string" ? a.card : a.card?.id;
  const p = purchases().find((x) => x.provider === "stripe" && x.cardId === cardId);
  const amountUsd = (a.pending_request?.amount ?? a.amount ?? 0) / 100;
  const currency = (a.pending_request?.currency ?? a.currency ?? "usd").toLowerCase();
  const merchant = a.merchant_data?.name ?? "unknown merchant";
  const verdict = (approved: boolean, reason: string) => {
    p?.authorizations.unshift({ at: new Date(now).toISOString(), amountUsd, merchant, approved, reason });
    if (p && approved) {
      p.status = "used";
      p.note = `Charged ${money(amountUsd)} by ${merchant}. Further charges on this card are declined.`;
    }
    return { approved, reason };
  };
  if (!p) return { approved: false, reason: "Not a card this app issued for a purchase" };
  if (state().killSwitch) return verdict(false, "The kill switch is on");
  if (p.status !== "issued") return verdict(false, p.status === "used" ? "This one-time card has already been charged" : `The purchase is ${p.status}`);
  if (p.expiresAt && Date.parse(p.expiresAt) <= now) return verdict(false, "The card's time is up");
  if (currency !== "usd") return verdict(false, `Charged in ${currency.toUpperCase()}; the card is for USD only`);
  if (!(amountUsd > 0)) return verdict(false, "No amount");
  if (amountUsd > p.amountUsd) return verdict(false, `${money(amountUsd)} is over the ${money(p.amountUsd)} this card was made for`);
  return verdict(true, `Within the ${money(p.amountUsd)} approved for ${p.merchant}`);
}

/** The Stripe webhook: verify, decide authorization requests, and record what happened. */
/**
 * The Stripe webhook of one business (its URL carries ?b=<id>; none means the operator's own): checked against that business's own signing
 * secret, so one business's Stripe account can never approve a charge on another's cards.
 */
export async function handleStripeWebhook(raw: string, signature: string | null, biz = DEFAULT_BIZ): Promise<{ status: number; body: Record<string, unknown>; decision?: boolean }> {
  // Stripe waits two seconds for an answer: if this business's records stay busy longer, the charge is declined (the caller answers no).
  return runAs(biz, () => withRecords(async () => {
    if (!stripeSignatureValid(raw, signature, cfg().STRIPE_WEBHOOK_SECRET)) return { status: 400, body: { error: "Bad signature" } };
    const event = JSON.parse(raw) as { type?: string; data?: { object?: StripeAuthorization } };
    const a = event.data?.object ?? {};
    if (event.type === "issuing_authorization.request") {
      const d = decideAuthorization(a);
      persist();
      return { status: 200, body: { approved: d.approved, metadata: { bluvfi_reason: d.reason.slice(0, 450) } }, decision: d.approved };
    }
    return { status: 200, body: { received: true } };
  }, 1_500));
}
