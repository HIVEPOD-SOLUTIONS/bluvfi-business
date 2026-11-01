import { handleVoiceDigit } from "@/lib/channels";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { twilioSignatureValid } from "@/lib/rails";
import { persist } from "@/lib/store";

/** Twilio calls this with the digit the vendor pressed. The request signature is verified against our public URL. */
export async function POST(req: Request) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => (params[k] = String(v)));
  const u = new URL(req.url);
  const full = `${PUBLIC_BASE_URL}${u.pathname}${u.search}`;
  if (!twilioSignatureValid(full, params, req.headers.get("x-twilio-signature") ?? "")) return new Response("forbidden", { status: 403 });
  const say = handleVoiceDigit(u.searchParams.get("pid") ?? "", params.Digits ?? "");
  persist();
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${say}</Say></Response>`, { headers: { "content-type": "text/xml" } });
}
