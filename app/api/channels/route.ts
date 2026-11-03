import { channelStatus, setChannels, type ChannelInput } from "@/lib/business";
import { randomBytes } from "node:crypto";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { body, route } from "@/lib/http";
import { TELEGRAM_API } from "@/lib/rails";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";

/** Where outside services reach this business: its Telegram webhook, its cron endpoint for Agent Market, its Check endpoint. */
const urls = (origin: string) => {
  const q = currentBiz() === DEFAULT_BIZ ? "" : `?b=${currentBiz()}`;
  const base = PUBLIC_BASE_URL || origin;
  return { telegramWebhook: `${base}/api/telegram/webhook${q}`, agentMarketPoll: `${base}/api/agentmarket/poll${q}`, check: `${base}/api/check${q}`, ledger: `${base}/ledger${q}` };
};

export const GET = route(async (req) => {
  const who = await requireSigner(req);
  return { channels: channelStatus(currentBiz(), isOwner(who)), urls: urls(new URL(req.url).origin) };
});

/**
 * An owner sets the business's own channels. A Telegram bot is registered with Telegram here (setWebhook, with a secret
 * made for this business), and the settings are saved only if Telegram accepts it. Secrets are stored encrypted and
 * never sent back.
 */
export const POST = route(async (req) => {
  const who = await requireSigner(req);
  if (!isOwner(who)) throw new Error("Only an owner can change the business's channels");
  const input = await body<ChannelInput>(req);
  const allowed = ["telegramBotToken", "twilioSid", "twilioToken", "twilioFrom", "agentMarketToken", "pingpayKey", "x402FacilitatorUrl"] as const;
  const clean: ChannelInput = {};
  for (const k of allowed) if (typeof input[k] === "string") clean[k] = input[k];

  const notes: string[] = [];
  const generated: { telegramWebhookSecret?: string } = {};
  if (clean.telegramBotToken) {
    const base = PUBLIC_BASE_URL;
    if (!/^https:\/\//.test(base) && !process.env.TELEGRAM_API_BASE) throw new Error("PUBLIC_BASE_URL (https) is not set on this platform, so Telegram has nowhere to send replies");
    const secret = randomBytes(24).toString("hex");
    const r = await fetch(`${TELEGRAM_API}/bot${clean.telegramBotToken.trim()}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urls(base).telegramWebhook, secret_token: secret, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!r.ok || !j.ok) throw new Error(`Telegram did not accept that bot: ${j.description ?? r.status}`);
    generated.telegramWebhookSecret = secret;
    notes.push("Telegram bot registered: vendor replies now reach this business.");
  }
  setChannels(currentBiz(), clean, generated);
  return { channels: channelStatus(currentBiz(), true), urls: urls(new URL(req.url).origin), notes };
});
