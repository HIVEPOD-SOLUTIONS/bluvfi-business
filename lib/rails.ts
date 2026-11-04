import { cfg, secretEquals } from "./business";
import { currentBiz, DEFAULT_BIZ } from "./tenant";
import { createHmac } from "node:crypto";
import { ASSET_ID, NEAR_USDC_CONTRACT } from "./chains";
import { ONECLICK_BASE, ONECLICK_DRY, ONECLICK_JWT, PUBLIC_BASE_URL, X402_PAYER_TOKEN, X402_PAYER_URL, X402_TESTNET } from "./config";
import type { CallbackRecord, Channel, Confidentiality, Invoice, Quote } from "./types";

export const TELEGRAM_API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

const oneClickHeaders = () => ({ "content-type": "application/json", ...(ONECLICK_JWT ? { authorization: `Bearer ${ONECLICK_JWT}` } : {}) });

interface QuoteInput {
  originAsset: string;
  destinationAsset: string;
  /** Raw units of the destination asset (EXACT_OUTPUT). */
  amountOut: string;
  recipient: string;
  refundTo: string;
  confidentiality?: Confidentiality;
  /** How long the quote's deadline is from now. Default 30 minutes. */
  deadlineMs?: number;
}

/** A real (non-dry) NEAR Intents 1Click quote on mainnet. Returns the deposit address to send to. */
async function oneClickQuote(q: QuoteInput): Promise<Quote> {
  const res = await fetch(`${ONECLICK_BASE}/v0/quote`, {
    method: "POST",
    headers: oneClickHeaders(),
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      dry: ONECLICK_DRY,
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
      deadline: new Date(Date.now() + (q.deadlineMs ?? 30 * 60_000)).toISOString(),
      // Privacy is a per-payment choice. If 1Click rejects the field the request fails and nothing is silently downgraded.
      ...(q.confidentiality && q.confidentiality !== "public" ? { confidentiality: q.confidentiality } : {}),
    }),
  });
  if (!res.ok) throw new Error(`1Click quote failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { signature?: string; quote?: { amountIn?: string; amountInFormatted?: string; amountOutFormatted?: string; depositAddress?: string; depositMemo?: string; deadline?: string; timeWhenInactive?: string } };
  if (ONECLICK_DRY && j.quote) return { depositAddress: "(dry run: no deposit address)", amountIn: j.quote.amountInFormatted ?? "", amountInRaw: j.quote.amountIn, amountOut: j.quote.amountOutFormatted ?? "", source: "1click-dry" };
  if (!j.quote?.depositAddress) throw new Error("1Click returned no deposit address");
  return {
    depositAddress: j.quote.depositAddress,
    depositMemo: j.quote.depositMemo,
    amountIn: j.quote.amountInFormatted ?? "",
    amountInRaw: j.quote.amountIn,
    amountOut: j.quote.amountOutFormatted ?? "",
    deadline: j.quote.deadline,
    timeWhenInactive: j.quote.timeWhenInactive,
    signature: j.signature,
    source: "1click",
  };
}

const toRaw = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();

/** Outgoing payout: the treasury pays USDC on NEAR, the vendor receives the invoice asset on its chain. */
export function quotePayout(inv: Invoice, confidentiality: Confidentiality, deadlineMs?: number): Promise<Quote> {
  const dest = ASSET_ID[`${inv.chain}:${inv.asset}`];
  if (!dest) throw new Error(`No NEAR Intents route for ${inv.asset} on ${inv.chain}`);
  if (!cfg().TREASURY_ACCOUNT) throw new Error("TREASURY_ACCOUNT is not set");
  return oneClickQuote({
    originAsset: ASSET_ID["near:USDC"],
    destinationAsset: dest,
    amountOut: toRaw(inv.amountUsd),
    recipient: inv.payoutAddress,
    refundTo: cfg().TREASURY_ACCOUNT,
    confidentiality,
    deadlineMs,
  });
}

/** Incoming payment: a client pays USDC from `fromChain`, the treasury receives USDC on NEAR. */
export function quoteReceivable(amountUsd: number, fromChain: string, refundTo: string, payTo: string): Promise<Quote> {
  const origin = ASSET_ID[`${fromChain}:USDC`];
  if (!origin) throw new Error(`No NEAR Intents route for USDC on ${fromChain}`);
  return oneClickQuote({ originAsset: origin, destinationAsset: ASSET_ID["near:USDC"], amountOut: toRaw(amountUsd), recipient: payTo, refundTo });
}

/**
 * Tell 1Click a deposit was sent, with its transaction hash, so it can verify it early instead of waiting to see it.
 * 1Click treats this as optional, so a failure never blocks anything: the status check still settles the payment.
 */
export async function submitDeposit(txHash: string, depositAddress: string, depositMemo?: string): Promise<boolean> {
  try {
    const res = await fetch(`${ONECLICK_BASE}/v0/deposit/submit`, {
      method: "POST",
      headers: oneClickHeaders(),
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ txHash, depositAddress, ...(depositMemo ? { memo: depositMemo } : {}) }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
    `Hi, this is the finance agent at ${cfg().COMPANY_NAME}. Invoice ${inv.invoiceNumber} for $${inv.amountUsd.toLocaleString()} ` +
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
    if (target.channel === "telegram" && cfg().TELEGRAM_BOT_TOKEN) {
      const r = await fetch(`${TELEGRAM_API}/bot${cfg().TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target.handle, text: message }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return { ...base, delivered: "telegram" };
    }
    if (target.channel === "voice" && cfg().TWILIO_ACCOUNT_SID && cfg().TWILIO_AUTH_TOKEN && cfg().TWILIO_FROM && PUBLIC_BASE_URL) {
      // The business is in the link, so Twilio's reply finds it; the signature covers the whole URL, so it cannot be changed.
      const action = `${PUBLIC_BASE_URL}/api/twilio/voice?pid=${encodeURIComponent(paymentId)}${currentBiz() === DEFAULT_BIZ ? "" : `&b=${currentBiz()}`}`;
      const say = `Hello, this is the finance agent at ${esc(cfg().COMPANY_NAME)}. Invoice ${esc(inv.invoiceNumber)} for ${Math.round(inv.amountUsd)} dollars has new payment details. Press 1 if you sent it and the details are correct. Press 2 if you did not.`;
      // No key pressed: record a short spoken answer, transcribed by Whisper on NEAR AI (lib/transcribe.ts).
      const twiml = `<Response><Gather numDigits="1" action="${esc(action)}" method="POST"><Say>${say}</Say></Gather><Say>Or say yes or no after the beep.</Say><Record maxLength="6" playBeep="true" action="${esc(action)}" method="POST"/></Response>`;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg().TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg().TWILIO_ACCOUNT_SID}:${cfg().TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: target.handle, From: cfg().TWILIO_FROM, Twiml: twiml }),
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
  if (!cfg().TWILIO_AUTH_TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return secretEquals(signature, createHmac("sha1", cfg().TWILIO_AUTH_TOKEN).update(data).digest("base64"));
}

/**
 * x402: the agent pays a paywalled API. The policy gate runs first (see agent.spendX402).
 * Signing the payment is delegated to X402_PAYER_URL so this app never holds a payment key:
 * POST {url, requirements} -> {paymentHeader}.
 */
export interface X402Result { ok: boolean; status: number; priceUsd: number; body?: unknown; paymentHeader?: string; note: string }

/** One entry of a 402's `accepts`: x402 v1 names the price `maxAmountRequired`, v2 names it `amount`. */
interface X402Accept { scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string; maxAmountRequired?: string }

/** USDC, the only asset the agent pays in: the price is read as 6 decimals, so any other asset is refused. */
const X402_USDC = new Set([
  NEAR_USDC_CONTRACT.toLowerCase(),
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum
  "epjfwdd5aufqsseqm2qn1xzybapc8g4weggkzwytdt1v", // Solana
  ...(X402_TESTNET ? ["0x036cbd53842c5426634e7929541ec2318f3dcf7e"] : []), // Base Sepolia test USDC, only when X402_TESTNET=1
]);

/** The payment requirements a 402 carries: in the JSON body (v1, and ours) or the base64 PAYMENT-REQUIRED header (v2). */
async function x402Requirements(res: Response): Promise<{ accepts: X402Accept[]; resource?: unknown }> {
  const fromBody = (await res.json().catch(() => null)) as { accepts?: X402Accept[]; resource?: unknown } | null;
  if (fromBody?.accepts?.length) return { accepts: fromBody.accepts, resource: fromBody.resource };
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: X402Accept[]; resource?: unknown };
      return { accepts: j.accepts ?? [], resource: j.resource };
    } catch {
      return { accepts: [] };
    }
  }
  return { accepts: [] };
}

/** What a paid API returned: its JSON if it is JSON, otherwise its text (a paid page or file is still what was bought). */
async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

export async function payX402(url: string, maxPriceUsd: number): Promise<X402Result> {
  const first = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (first.status !== 402) return { ok: first.ok, status: first.status, priceUsd: 0, body: await bodyOf(first), note: "No payment required." };
  const required = await x402Requirements(first);
  // An API may offer several ways to pay (a chain each): take the first this agent is willing to pay in.
  const accept = required.accepts.find((a) => a.asset && X402_USDC.has(a.asset.toLowerCase())) ?? required.accepts[0];
  if (!accept) return { ok: false, status: 402, priceUsd: 0, note: "The API asked for payment but did not say how, so nothing was paid." };
  // Never pay a price that cannot be read, or in an asset whose units are not known: an unreadable price must not slip past the cap.
  if (!accept.asset || !X402_USDC.has(accept.asset.toLowerCase())) return { ok: false, status: 402, priceUsd: 0, note: `The API wants payment in ${accept.asset ?? "an unknown asset"}. The agent pays in USDC only, so nothing was paid.` };
  const priceUsd = Number(accept.amount ?? accept.maxAmountRequired) / 1e6;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, status: 402, priceUsd: 0, note: "The API's price could not be read, so nothing was paid." };
  if (priceUsd > maxPriceUsd) return { ok: false, status: 402, priceUsd, note: `Price $${priceUsd} exceeds the allowed $${maxPriceUsd}.` };
  if (!X402_PAYER_URL) throw new Error("X402_PAYER_URL is not set, so the agent cannot sign x402 payments");
  const signed = await fetch(`${X402_PAYER_URL}/pay`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(X402_PAYER_TOKEN ? { authorization: `Bearer ${X402_PAYER_TOKEN}` } : {}) },
    body: JSON.stringify({ url, requirements: accept, resource: required.resource }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!signed.ok) throw new Error(`x402 payer refused (${signed.status})`);
  const { paymentHeader } = (await signed.json()) as { paymentHeader?: string };
  if (!paymentHeader) throw new Error("x402 payer returned no payment header");
  // v1 servers read X-PAYMENT, v2 servers PAYMENT-SIGNATURE; the same value goes in both.
  const paid = await fetch(url, { headers: { "X-PAYMENT": paymentHeader, "PAYMENT-SIGNATURE": paymentHeader }, signal: AbortSignal.timeout(30_000) });
  return { ok: paid.ok, status: paid.status, priceUsd, body: await bodyOf(paid), paymentHeader, note: paid.ok ? "Paid and delivered." : "Paid but the API did not deliver." };
}

/**
 * Quote for Aurora's Intents swap widget on a pay link (its `fetchQuote` hook). The widget proposes a 1Click
 * QuoteRequest from the payer's wallet and token; we keep only what is the payer's to choose (origin asset,
 * deposit type, refund address) and force the rest: EXACT_OUTPUT of the invoice amount, USDC on NEAR, to our
 * treasury. The widget then pays the returned deposit address, so the usual 1Click status check settles it.
 * Returns 1Click's raw `quote` object, which is what the widget expects.
 */
export async function quoteForWidget(request: Record<string, unknown>, amountUsd: number, payTo: string): Promise<Record<string, unknown> & { depositAddress?: string; depositMemo?: string; amountInFormatted?: string; deadline?: string }> {
  const originAsset = String(request.originAsset ?? "");
  if (!/^nep(141|245):/.test(originAsset)) throw new Error("The widget sent no origin asset");
  const dry = request.dry !== false;
  const body = {
    dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: Math.min(Number(request.slippageTolerance ?? 100) || 100, 300),
    originAsset,
    depositType: request.depositType === "INTENTS" ? "INTENTS" : "ORIGIN_CHAIN",
    destinationAsset: ASSET_ID["near:USDC"],
    amount: toRaw(amountUsd),
    refundTo: String(request.refundTo ?? ""),
    refundType: request.refundType === "INTENTS" ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: payTo,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...(request.depositMode === "MEMO" ? { depositMode: "MEMO" } : {}),
    ...(request.confidentiality === "basic" || request.confidentiality === "advanced" ? { confidentiality: request.confidentiality } : {}),
  };
  // A preview (dry) quote may carry the widget's placeholder refund target; a real one must name the payer's.
  if (!dry && !body.refundTo) throw new Error("Connect a wallet so a refund can go back to it if anything fails");
  const res = await fetch(`${ONECLICK_BASE}/v0/quote`, { method: "POST", headers: oneClickHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`1Click quote failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { quote?: Record<string, unknown> };
  if (!j.quote) throw new Error("1Click returned no quote");
  return j.quote as Awaited<ReturnType<typeof quoteForWidget>>;
}
