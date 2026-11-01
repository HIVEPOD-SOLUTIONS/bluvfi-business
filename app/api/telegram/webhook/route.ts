import { NextResponse } from "next/server";
import { handleTelegramReply } from "@/lib/channels";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } from "@/lib/config";
import { persist } from "@/lib/store";

/**
 * Telegram webhook for vendor replies. Register it with setWebhook, passing the same secret_token as
 * TELEGRAM_WEBHOOK_SECRET; Telegram echoes it back in a header, which is checked here.
 */
export async function POST(req: Request) {
  if (!TELEGRAM_WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const u = (await req.json().catch(() => ({}))) as { message?: { chat?: { id?: number }; text?: string } };
  const chatId = u.message?.chat?.id;
  if (chatId === undefined || !u.message?.text) return NextResponse.json({ ok: true });
  const { reply } = handleTelegramReply(String(chatId), u.message.text);
  persist();
  if (TELEGRAM_BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
