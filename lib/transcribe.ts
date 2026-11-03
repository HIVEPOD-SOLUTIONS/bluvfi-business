import { cfg } from "./business";
import { NEAR_AI_BASE, NEAR_AI_KEY } from "./config";

/**
 * A vendor's spoken answer on a voice callback, transcribed by Whisper on NEAR AI Cloud
 * (`POST /v1/audio/transcriptions`, model openai/whisper-large-v3). The recording is fetched from Twilio with
 * our account credentials and passed straight through; it is not stored here.
 */
export async function transcribeTwilioRecording(recordingUrl: string): Promise<string> {
  if (!NEAR_AI_KEY) throw new Error("NEAR_AI_API_KEY is not set");
  if (!/^https:\/\/api\.twilio\.com\//.test(recordingUrl)) throw new Error("Not a Twilio recording URL");
  const audio = await fetch(`${recordingUrl}.wav`, {
    headers: { authorization: `Basic ${Buffer.from(`${cfg().TWILIO_ACCOUNT_SID}:${cfg().TWILIO_AUTH_TOKEN}`).toString("base64")}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!audio.ok) throw new Error(`Twilio recording fetch failed (${audio.status})`);
  const form = new FormData();
  form.append("file", new Blob([await audio.arrayBuffer()], { type: "audio/wav" }), "answer.wav");
  form.append("model", "openai/whisper-large-v3");
  form.append("response_format", "json");
  const res = await fetch(`${NEAR_AI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${NEAR_AI_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`NEAR AI transcription failed (${res.status})`);
  return String(((await res.json()) as { text?: string }).text ?? "").trim();
}

/** "yes" or "no" from a short spoken answer, or undefined when it is unclear (a human then decides). */
export function spokenAnswer(transcript: string): "yes" | "no" | undefined {
  const t = transcript.toLowerCase();
  const no = /\b(no|nope|not us|wasn'?t us|did not|didn'?t)\b/.test(t);
  const yes = /\b(yes|yeah|yep|correct|that was us|it was us|confirm(ed)?)\b/.test(t);
  return yes === no ? undefined : yes ? "yes" : "no";
}
