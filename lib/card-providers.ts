import { constants, createDecipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { cfg } from "./business";
import { pickCardProvider, rampBases, STRIPE_API_BASE, STRIPE_API_VERSION, type Cfg } from "./config";
import { sha256 } from "./crypto";

/**
 * The card issuers the agent gets one-time cards from (lib/cards.ts holds the policy around them). Each business uses its own account. Each issues a virtual card capped at
 * one purchase's amount, hands back its number once, and closes it. Built to each provider's documentation; tested against local servers
 * that speak their APIs.
 */

export type CardProviderId = "stripe" | "ramp" | "rain" | "demo";
export interface CardSecrets { number: string; cvc: string; expiry: string }
export interface IssueRequest { purchaseId: string; merchant: string; amountUsd: number }
export interface Issued { cardId: string; last4: string; closeRef?: string; secrets: CardSecrets }
export interface CardProvider {
  id: CardProviderId;
  name: string;
  issue(req: IssueRequest): Promise<Issued>;
  close(cardId: string, closeRef?: string): Promise<void>;
}

const cents = (usd: number) => Math.round(usd * 100);
const two = (n: number | string) => String(n).padStart(2, "0").slice(-2);
const expiry = (month: number | string, year: number | string) => `${two(month)}/${two(year)}`;

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = j.error as { message?: string } | string | undefined;
    const msg = typeof err === "string" ? err : (err?.message ?? (j.message as string | undefined) ?? text.slice(0, 200));
    throw new Error(`${what} failed (${res.status}): ${msg}`);
  }
  return j;
}

// ---------- Stripe Issuing ----------

export function stripeProvider(c: { key: string; cardholder: string; base?: string; version?: string }): CardProvider {
  const base = c.base ?? "https://api.stripe.com";
  const headers = { authorization: `Bearer ${c.key}`, "stripe-version": c.version ?? STRIPE_API_VERSION, "content-type": "application/x-www-form-urlencoded" };
  const call = async (method: string, path: string, form?: Record<string, string>) =>
    json(await fetch(`${base}${path}`, { method, headers, body: form ? new URLSearchParams(form) : undefined, signal: AbortSignal.timeout(20_000) }), `Stripe ${method} ${path.split("?")[0]}`);
  return {
    id: "stripe",
    name: "Stripe Issuing",
    async issue(r) {
      const card = await call("POST", "/v1/issuing/cards", {
        cardholder: c.cardholder,
        currency: "usd",
        type: "virtual",
        status: "active",
        // Stripe itself refuses anything past the amount over the card's whole life.
        "spending_controls[spending_limits][0][amount]": String(cents(r.amountUsd)),
        "spending_controls[spending_limits][0][interval]": "all_time",
        "metadata[bluvfi_purchase]": r.purchaseId,
        "metadata[merchant]": r.merchant.slice(0, 450),
      });
      const id = String(card.id ?? "");
      if (!/^ic_/.test(id)) throw new Error("Stripe did not return a card");
      // The number and CVC are only returned when asked for by name (and, in live mode, only to accounts Stripe has cleared for it).
      const full = await call("GET", `/v1/issuing/cards/${id}?expand[]=number&expand[]=cvc`);
      if (!full.number || !full.cvc) throw new Error("Stripe made the card but did not return its number; live mode needs Stripe's approval to read card numbers");
      return { cardId: id, last4: String(full.last4 ?? String(full.number).slice(-4)), secrets: { number: String(full.number), cvc: String(full.cvc), expiry: expiry(Number(full.exp_month), Number(full.exp_year)) } };
    },
    async close(cardId) {
      await call("POST", `/v1/issuing/cards/${cardId}`, { status: "canceled" });
    },
  };
}

// ---------- Ramp (Vault API: a fund and a card made together, with the card's details in the response) ----------

export function rampProvider(c: { clientId: string; clientSecret: string; userId: string; apiBase: string; vaultBase: string }): CardProvider {
  let token: { value: string; until: number } | undefined;
  async function bearer(): Promise<string> {
    if (token && token.until > Date.now() + 30_000) return token.value;
    const res = await fetch(`${c.apiBase}/developer/v1/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "cards:read_vault limits:write funds:write" }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await json(res, "Ramp token");
    if (!j.access_token) throw new Error("Ramp returned no access token");
    token = { value: String(j.access_token), until: Date.now() + Number(j.expires_in ?? 600) * 1000 };
    return token.value;
  }
  return {
    id: "ramp",
    name: "Ramp Agent Cards",
    async issue(r) {
      const res = await fetch(`${c.vaultBase}/developer/v1/cards/vault`, {
        method: "POST",
        headers: { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" },
        body: JSON.stringify({
          user_id: c.userId,
          display_name: `Bluvfi ${r.purchaseId}: ${r.merchant}`.slice(0, 60),
          // A total (not monthly) limit of exactly the purchase: the card cannot be charged past it. Amounts in cents.
          spending_restrictions: { limit: { amount: cents(r.amountUsd), currency_code: "USD" }, interval: "TOTAL" },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await json(res, "Ramp card");
      const card = j.card as { id?: string; pan?: string; cvv?: string; expiration?: string } | undefined;
      if (!card?.id || !card.pan || !card.cvv) throw new Error("Ramp did not return the card's details");
      const digits = String(card.expiration ?? "").replace(/\D/g, "");
      // Ramp's expiration may come as MMYY, MM/YY or YYYY-MM: read the month and the year's last two digits.
      const exp = /^\d{4}$/.test(digits) ? `${digits.slice(0, 2)}/${digits.slice(2)}` : /^\d{6}$/.test(digits) ? (Number(digits.slice(0, 2)) <= 12 ? `${digits.slice(0, 2)}/${digits.slice(4)}` : `${digits.slice(4)}/${digits.slice(2, 4)}`) : String(card.expiration ?? "");
      return { cardId: card.id, last4: card.pan.slice(-4), closeRef: j.spend_limit_id ? String(j.spend_limit_id) : undefined, secrets: { number: card.pan, cvc: card.cvv, expiry: exp } };
    },
    async close(cardId, closeRef) {
      // Terminating the fund made for this card terminates the card with it. It is irreversible, which is the point.
      if (!closeRef) throw new Error(`No Ramp fund is recorded for card ${cardId}, so it cannot be closed from here; close it in Ramp`);
      const res = await fetch(`${c.apiBase}/developer/v1/funds/${closeRef}`, { method: "DELETE", headers: { authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok && res.status !== 404) await json(res, "Ramp close");
    },
  };
}

// ---------- Rain (stablecoin-collateralized cards; card numbers come back encrypted under a key we make for the request) ----------

/** A session for reading a card's number: a fresh AES key, sent to Rain encrypted with Rain's public key. */
export function rainSession(publicKeyPem: string): { secretHex: string; sessionId: string } {
  const secretHex = randomBytes(16).toString("hex");
  const sessionId = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(Buffer.from(secretHex, "hex").toString("base64"), "utf8")).toString("base64");
  return { secretHex, sessionId };
}

/** Rain's encrypted fields: base64 iv, and base64 ciphertext with the 16-byte GCM tag at its end. */
export function rainDecrypt(field: { iv?: string; data?: string } | undefined, secretHex: string): string {
  if (!field?.iv || !field.data) throw new Error("Rain returned no encrypted card details");
  const data = Buffer.from(field.data, "base64");
  const d = createDecipheriv("aes-128-gcm", Buffer.from(secretHex, "hex"), Buffer.from(field.iv, "base64"));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString("utf8");
}

export function rainProvider(c: { apiKey: string; userId: string; publicKeyPem: string; base: string }): CardProvider {
  const headers = { "Api-Key": c.apiKey, "content-type": "application/json" };
  return {
    id: "rain",
    name: "Rain",
    async issue(r) {
      const card = await json(await fetch(`${c.base}/issuing/users/${c.userId}/cards`, {
        method: "POST",
        headers,
        // An all-time limit of exactly the purchase. Amounts in cents.
        body: JSON.stringify({ type: "virtual", status: "active", displayName: `Bluvfi ${r.purchaseId}`.slice(0, 40), limit: { frequency: "allTime", amount: cents(r.amountUsd) } }),
        signal: AbortSignal.timeout(20_000),
      }), "Rain card");
      const id = String(card.id ?? "");
      if (!id) throw new Error("Rain did not return a card");
      const { secretHex, sessionId } = rainSession(c.publicKeyPem);
      const secrets = await json(await fetch(`${c.base}/issuing/cards/${id}/secrets`, { headers: { "Api-Key": c.apiKey, SessionId: sessionId }, signal: AbortSignal.timeout(20_000) }), "Rain card details");
      const number = rainDecrypt(secrets.encryptedPan as { iv?: string; data?: string }, secretHex).replace(/\D/g, "");
      const cvc = rainDecrypt(secrets.encryptedCvc as { iv?: string; data?: string }, secretHex).replace(/\D/g, "");
      return { cardId: id, last4: String(card.last4 ?? number.slice(-4)), secrets: { number, cvc, expiry: expiry(String(card.expirationMonth ?? ""), String(card.expirationYear ?? "")) } };
    },
    async close(cardId) {
      await json(await fetch(`${c.base}/issuing/cards/${cardId}`, { method: "PATCH", headers, body: JSON.stringify({ status: "canceled" }), signal: AbortSignal.timeout(20_000) }), "Rain close");
    },
  };
}

/** Demo mode: a card that only exists on screen. Nothing can be charged to it. */
export const demoCardProvider = (): CardProvider => ({
  id: "demo",
  name: "Demo cards (not chargeable)",
  async issue(r) {
    const tail = sha256(r.purchaseId).replace(/\D/g, "").padEnd(4, "0").slice(0, 4);
    return { cardId: `demo_${r.purchaseId}`, last4: tail, secrets: { number: `4000 0000 0000 ${tail}`, cvc: "000", expiry: "12/30" } };
  },
  async close() {},
});

/** A business's provider, from its own card settings (Settings page; the operator's own business: its environment), or null. */
export function cardProviderFor(c: Cfg): CardProvider | null {
  const which = pickCardProvider(c);
  if (which === "stripe") return stripeProvider({ key: c.STRIPE_SECRET_KEY, cardholder: c.STRIPE_CARDHOLDER_ID, base: STRIPE_API_BASE });
  if (which === "ramp") {
    const b = rampBases(c.RAMP_SANDBOX);
    return rampProvider({ clientId: c.RAMP_CLIENT_ID, clientSecret: c.RAMP_CLIENT_SECRET, userId: c.RAMP_USER_ID, apiBase: b.api, vaultBase: b.vault });
  }
  if (which === "rain") return rainProvider({ apiKey: c.RAIN_API_KEY, userId: c.RAIN_USER_ID, publicKeyPem: c.RAIN_SECRETS_PUBLIC_KEY, base: c.RAIN_BASE_URL });
  return null;
}

/** The provider of the business this request runs in. Each business uses its own card-issuing account; none falls back to another's. */
export function configuredCardProvider(): CardProvider | null {
  return cardProviderFor(cfg());
}
