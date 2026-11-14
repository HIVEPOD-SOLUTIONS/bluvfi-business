import { isDemo } from "./tenant";
import { NEAR_AI_BASE, NEAR_AI_KEY } from "./config";

const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\+?\d[\d\s().-]{8,}\d/g, "[PHONE]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[IBAN]"],
  [/\b0x[a-fA-F0-9]{40,64}\b/g, "[WALLET]"],
  [/\b(?:[a-z0-9_-]+\.)+near\b/g, "[WALLET]"], // NEAR accounts, sub-accounts included (pay.acme.near)
  [/\b[a-f0-9]{64}\b/g, "[WALLET]"], // NEAR implicit accounts
  [/\bbc1[a-z0-9]{25,62}\b/g, "[WALLET]"], // Bitcoin (bech32)
  [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "[WALLET]"], // Solana, Tron and other base58 addresses
  [/@[A-Za-z0-9_]{4,}/g, "[HANDLE]"],
];

export interface Redaction {
  text: string;
  /** near-ai: NEAR AI Cloud's privacy filter ran inside its TEE, then the local patterns. local-regex: patterns only. */
  source: "near-ai+local-regex" | "local-regex";
  note?: string;
}

const local = (text: string) => RULES.reduce((t, [re, to]) => t.replace(re, to), text);

/**
 * Strip names, bank details, contacts and wallets before any reasoning call (Electric Capital's Quest idea:
 * redact before reasoning). First NEAR AI Cloud's `POST /v1/privacy/redact` with the `openai/privacy-filter`
 * model, which runs in the same TEE-backed gateway as the reviewer, then local patterns for wallets and
 * handles the filter may not treat as personal data. If the filter is unreachable only the patterns run, and
 * the record says so. The deterministic checks run on the original data, which never leaves this process.
 */
export async function redact(text: string): Promise<Redaction> {
  if (!NEAR_AI_KEY || isDemo()) return { text: local(text), source: "local-regex" };
  try {
    const res = await fetch(`${NEAR_AI_BASE}/privacy/redact`, {
      method: "POST",
      headers: { authorization: `Bearer ${NEAR_AI_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/privacy-filter", input: text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = (await res.json()) as { data?: { index: number; redacted: string }[] };
    const out = j.data?.find((d) => d.index === 0)?.redacted;
    if (typeof out !== "string") throw new Error("no redacted text in the response");
    return { text: local(out), source: "near-ai+local-regex" };
  } catch (e) {
    return { text: local(text), source: "local-regex", note: `NEAR AI privacy filter unavailable (${(e as Error).message}); local patterns only.` };
  }
}
