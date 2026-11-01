const RULES: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\+?\d[\d\s().-]{8,}\d/g, "[PHONE]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[IBAN]"],
  [/\b0x[a-fA-F0-9]{40}\b/g, "[WALLET]"],
  [/\b[a-z0-9_-]+\.near\b/g, "[WALLET]"],
  [/@[A-Za-z0-9_]{4,}/g, "[HANDLE]"],
];

export interface Redaction {
  text: string;
  source: "local-regex";
}

/**
 * Strip bank details, contacts and wallets before any reasoning call, locally and with patterns only.
 * (NEAR AI Cloud documents no redaction endpoint, so none is called.) Patterns are not a guarantee: names
 * and free-text details can survive. The deterministic checks run on the original data, which never leaves this process.
 */
export async function redact(text: string): Promise<Redaction> {
  return { text: RULES.reduce((t, [re, to]) => t.replace(re, to), text), source: "local-regex" };
}
