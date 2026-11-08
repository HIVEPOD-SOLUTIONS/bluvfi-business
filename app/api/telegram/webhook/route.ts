import { NextResponse } from "next/server";
import { bizFromRequest, cfg, secretEquals } from "@/lib/business";
import { handleTelegramReply } from "@/lib/channels";
import { TELEGRAM_API } from "@/lib/rails";
import { withRecords } from "@/lib/store";
import { runAs } from "@/lib/tenant";

/**
 * Telegram webhook for vendor replies, one per business: the business's own bot is registered (from Settings) with
 * this URL plus `?b=<business id>` and a secret_token that only that business has; Telegram echoes the secret back in
 * a header, which is checked here against that business's secret. A reply can only touch its own business's payments.
 */
export async function POST(req: Request) {
  let biz: string;
  try {
    biz = bizFromRequest(req);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return runAs(biz, async () => {
    if (!secretEquals(req.headers.get("x-telegram-bot-api-secret-token") ?? "", cfg().TELEGRAM_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const u = (await req.json().catch(() => ({}))) as { message?: { chat?: { id?: number }; text?: string } };
    const chatId = u.message?.chat?.id;
    if (chatId === undefined || !u.message?.text) return NextResponse.json({ ok: true });
    const { reply } = await withRecords(() => handleTelegramReply(String(chatId), u.message!.text!));
    if (cfg().TELEGRAM_BOT_TOKEN) {
      await fetch(`${TELEGRAM_API}/bot${cfg().TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: reply }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    return NextResponse.json({ ok: true });
  });
}
