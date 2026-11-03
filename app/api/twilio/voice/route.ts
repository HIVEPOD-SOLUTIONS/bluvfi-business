import { bizFromRequest } from "@/lib/business";
import { handleVoiceDigit, handleVoiceSpeech } from "@/lib/channels";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { twilioSignatureValid } from "@/lib/rails";
import { persist } from "@/lib/store";
import { runAs } from "@/lib/tenant";
import { transcribeTwilioRecording } from "@/lib/transcribe";

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Twilio calls this with the digit the vendor pressed, or with a recording of a spoken yes/no, which is
 * transcribed by Whisper on NEAR AI. The call was made with the business's own Twilio account, and the URL names the
 * business (`?b=`); the request signature is verified against that business's auth token and our public URL.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => (params[k] = String(v)));
  const u = new URL(req.url);
  let biz: string;
  try {
    biz = bizFromRequest(req);
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  return runAs(biz, async () => {
    const full = `${PUBLIC_BASE_URL}${u.pathname}${u.search}`;
    if (!twilioSignatureValid(full, params, req.headers.get("x-twilio-signature") ?? "")) return new Response("forbidden", { status: 403 });
    const pid = u.searchParams.get("pid") ?? "";
    let say: string;
    if (params.Digits) say = handleVoiceDigit(pid, params.Digits);
    else if (params.RecordingUrl) {
      try {
        say = handleVoiceSpeech(pid, await transcribeTwilioRecording(params.RecordingUrl));
      } catch {
        say = "Sorry, we could not process your answer. Someone from our team will contact you. Goodbye.";
      }
    } else say = "No answer received. Goodbye.";
    persist();
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(say)}</Say></Response>`, { headers: { "content-type": "text/xml" } });
  });
}
