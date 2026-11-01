import { createHmac } from "node:crypto";
import { ASSET_ID } from "./chains";
import {
  COMPANY_NAME, ONECLICK_BASE, ONECLICK_JWT, PUBLIC_BASE_URL, TELEGRAM_BOT_TOKEN, TREASURY_ACCOUNT,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, X402_PAYER_URL,
} from "./config";
import type { CallbackRecord, Channel, Confidentiality, Invoice, Quote } from "./types";

const oneClickHeaders = () => ({ "content-type": "application/json", ...(ONECLICK_JWT ? { authorization: `Bearer ${ONECLICK_JWT}` } : {}) });

interface QuoteInput {
  originAsset: string;
  destinationAsset: string;
  /** Raw units of the destination asset (EXACT_OUTPUT). */
  amountOut: string;
  recipient: string;
  refundTo: string;
  confidentiality?: Confidentiality;
}

/** A real (non-dry) NEAR Intents 1Click quote on mainnet. Returns the deposit address to send to. */
async function oneClickQuote(q: QuoteInput): Promise<Quote> {
  const res = await fetch(`${ONECLICK_BASE}/v0/quote`, {
    method: "POST",
    headers: oneClickHeaders(),
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: q.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: q.destinationAsset,
      amount: q.amountOut,
      refundTo: q.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: q.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      // Privacy is a per-payment choice. If 1Click rejects the field the request fails and nothing is silently downgraded.
      ...(q.confidentiality && q.confidentiality !== "public" ? { confidentiality: q.confidentiality } : {}),
    }),
  });
  if (!res.ok) throw new Error(`1Click quote failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { quote?: { amountInFormatted?: string; amountOutFormatted?: string; depositAddress?: string; depositMemo?: string; deadline?: string } };
  if (!j.quote?.depositAddress) throw new Error("1Click returned no deposit address");
  return {
    depositAddress: j.quote.depositAddress,
    depositMemo: j.quote.depositMemo,
    amountIn: j.quote.amountInFormatted ?? "",
    amountOut: j.quote.amountOutFormatted ?? "",
    deadline: j.quote.deadline,
    source: "1click",
  };
}

const toRaw = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();

/** Outgoing payout: the treasury pays USDC on NEAR, the vendor receives the invoice asset on its chain. */
export function quotePayout(inv: Invoice, confidentiality: Confidentiality): Promise<Quote> {
  const dest = ASSET_ID[`${inv.chain}:${inv.asset}`];
  if (!dest) throw new Error(`No NEAR Intents route for ${inv.asset} on ${inv.chain}`);
  if (!TREASURY_ACCOUNT) throw new Error("TREASURY_ACCOUNT is not set");
  return oneClickQuote({
    originAsset: ASSET_ID["near:USDC"],
    destinationAsset: dest,
    amountOut: toRaw(inv.amountUsd),
    recipient: inv.payoutAddress,
    refundTo: TREASURY_ACCOUNT,
    confidentiality,
  });
}

/** Incoming payment: a client pays USDC from `fromChain`, the treasury receives USDC on NEAR. */
export function quoteReceivable(amountUsd: number, fromChain: string, refundTo: string, payTo: string): Promise<Quote> {
  const origin = ASSET_ID[`${fromChain}:USDC`];
  if (!origin) throw new Error(`No NEAR Intents route for USDC on ${fromChain}`);
  return oneClickQuote({ originAsset: origin, destinationAsset: ASSET_ID["near:USDC"], amountOut: toRaw(amountUsd), recipient: payTo, refundTo });
}

/** 1Click swap status for a deposit address: PENDING_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED, ... */
export async function swapStatus(depositAddress: string, depositMemo?: string): Promise<string> {
  const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
  const res = await fetch(`${ONECLICK_BASE}/v0/status?${q}`, {
    headers: oneClickHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`1Click status failed (${res.status})`);
  return String(((await res.json()) as { status?: string }).status ?? "UNKNOWN");
}

export interface CallbackTarget { channel: Channel; handle: string }

/**
 * Callback to the vendor's previously verified channel (never the one on the invoice).
 * Telegram: handle is the vendor's chat id with our bot. Voice: E.164 number via Twilio.
 * Email, or any channel that is not configured, is manual: a human contacts the vendor and records the answer.
 */
export async function sendCallback(inv: Invoice, target: CallbackTarget | undefined, why: string, paymentId: string): Promise<CallbackRecord> {
  const message =
    `Hi, this is the finance agent at ${COMPANY_NAME}. Invoice ${inv.invoiceNumber} for $${inv.amountUsd.toLocaleString()} ` +
    `${why}. Did you send it, and are the new details correct? Reply YES ${inv.invoiceNumber} or NO ${inv.invoiceNumber}.`;
  const base: CallbackRecord = {
    channel: target?.channel ?? "email",
    handle: target?.handle ?? "(no verified contact on file)",
    sentAt: new Date().toISOString(),
    message,
    status: "pending",
    delivered: "manual",
  };
  if (!target) return base;
  try {
    if (target.channel === "telegram" && TELEGRAM_BOT_TOKEN) {
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target.handle, text: message }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ...base, delivered: "telegram" };
    }
    if (target.channel === "voice" && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && PUBLIC_BASE_URL) {
      const action = `${PUBLIC_BASE_URL}/api/twilio/voice?pid=${encodeURIComponent(paymentId)}`;
      const say = `Hello, this is the finance agent at ${esc(COMPANY_NAME)}. Invoice ${esc(inv.invoiceNumber)} for ${Math.round(inv.amountUsd)} dollars has new payment details. Press 1 if you sent it and the details are correct. Press 2 if you did not.`;
      const twiml = `<Response><Gather numDigits="1" action="${esc(action)}" method="POST"><Say>${say}</Say></Gather><Say>No answer received. Goodbye.</Say></Response>`;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: target.handle, From: TWILIO_FROM, Twiml: twiml }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ...base, delivered: "voice" };
    }
  } catch {
    /* falls through to manual */
  }
  return base;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function twilioSignatureValid(url: string, params: Record<string, string>, signature: string): boolean {
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", TWILIO_AUTH_TOKEN).update(data).digest("base64") === signature;
}

/**
 * x402: the agent pays a paywalled API. The policy gate runs first (see agent.spendX402).
 * Signing the payment is delegated to X402_PAYER_URL so this app never holds a payment key:
 * POST {url, requirements} -> {paymentHeader}.
 */
export interface X402Result { ok: boolean; status: number; priceUsd: number; body?: unknown; paymentHeader?: string; note: string }

export async function payX402(url: string, maxPriceUsd: number): Promise<X402Result> {
  const first = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (first.status !== 402) return { ok: first.ok, status: first.status, priceUsd: 0, body: await first.json().catch(() => null), note: "No payment required." };
  const req = (await first.json()) as { accepts: { maxAmountRequired: string; payTo: string; asset: string; network: string }[] };
  const accept = req.accepts[0];
  const priceUsd = Number(accept.maxAmountRequired) / 1e6;
  if (priceUsd > maxPriceUsd) return { ok: false, status: 402, priceUsd, note: `Price $${priceUsd} exceeds the allowed $${maxPriceUsd}.` };
  if (!X402_PAYER_URL) throw new Error("X402_PAYER_URL is not set, so the agent cannot sign x402 payments");
  const signed = await fetch(`${X402_PAYER_URL}/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, requirements: accept }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!signed.ok) throw new Error(`x402 payer refused (${signed.status})`);
  const { paymentHeader } = (await signed.json()) as { paymentHeader?: string };
  if (!paymentHeader) throw new Error("x402 payer returned no payment header");
  const paid = await fetch(url, { headers: { "X-PAYMENT": paymentHeader }, signal: AbortSignal.timeout(30_000) });
  return { ok: paid.ok, status: paid.status, priceUsd, body: await paid.json().catch(() => null), paymentHeader, note: paid.ok ? "Paid and delivered." : "Paid but the API did not deliver." };
}
