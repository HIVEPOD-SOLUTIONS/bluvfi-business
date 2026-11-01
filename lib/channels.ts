import { resolveCallback } from "./agent";
import { state } from "./store";
import { spokenAnswer } from "./transcribe";
import type { Payment } from "./types";

const pendingFor = (match: (p: Payment) => boolean) =>
  state().payments.filter((p) => p.callback?.status === "pending" && match(p));

/**
 * A vendor's reply on Telegram. `chatId` must equal the verified handle on file for a pending callback,
 * so a stranger writing to the bot cannot clear or deny anything. With several pending for one vendor
 * the reply has to name the invoice number ("YES INV-123").
 */
export function handleTelegramReply(chatId: string, text: string): { reply: string; paymentId?: string } {
  const answer = /\b(yes|no)\b/i.exec(text)?.[1]?.toLowerCase() as "yes" | "no" | undefined;
  if (!answer) return { reply: "Please reply YES or NO, followed by the invoice number." };
  const mine = pendingFor((p) => p.callback!.channel === "telegram" && p.callback!.handle === chatId);
  if (mine.length === 0) return { reply: "There is nothing waiting for your answer." };
  const named = mine.filter((p) => text.toLowerCase().includes(p.invoice.invoiceNumber.toLowerCase()));
  const target = mine.length === 1 ? mine[0] : named.length === 1 ? named[0] : undefined;
  if (!target) return { reply: "More than one invoice is waiting. Reply YES or NO followed by the invoice number." };
  resolveCallback(target.id, answer);
  return { reply: answer === "yes" ? "Thanks, confirmed." : "Thanks. We have cancelled the payment.", paymentId: target.id };
}

/** Digit pressed on a voice callback: 1 = it was us, 2 = it was not. */
export function handleVoiceDigit(paymentId: string, digit: string): string {
  const p = state().payments.find((x) => x.id === paymentId);
  if (!p?.callback || p.callback.status !== "pending" || p.callback.channel !== "voice") return "There is nothing waiting for your answer. Goodbye.";
  if (digit !== "1" && digit !== "2") return "Sorry, that was not a valid choice. Goodbye.";
  resolveCallback(p.id, digit === "1" ? "yes" : "no");
  return digit === "1" ? "Thank you. The details are confirmed. Goodbye." : "Thank you. We have cancelled the payment. Goodbye.";
}

/** Spoken answer on a voice callback, already transcribed. An unclear answer leaves the callback for a human. */
export function handleVoiceSpeech(paymentId: string, transcript: string): string {
  const p = state().payments.find((x) => x.id === paymentId);
  if (!p?.callback || p.callback.status !== "pending" || p.callback.channel !== "voice") return "There is nothing waiting for your answer. Goodbye.";
  const answer = spokenAnswer(transcript);
  if (!answer) {
    p.callback.answer = `Unclear spoken answer: "${transcript}" (transcribed by Whisper on NEAR AI). A person must confirm with the vendor.`;
    return "Sorry, we could not understand that. Someone from our team will contact you. Goodbye.";
  }
  resolveCallback(p.id, answer, `spoken "${transcript}", transcribed by Whisper on NEAR AI`);
  return answer === "yes" ? "Thank you. The details are confirmed. Goodbye." : "Thank you. We have cancelled the payment. Goodbye.";
}
