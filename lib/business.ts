import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMPANY_NAME, DEMO, ENV_CFG, type Cfg, type CustodyMode } from "./config";
import { decrypt, encrypt } from "./crypto";
import { dataKey } from "./store";
import { BIZ_ID, currentBiz, DEFAULT_BIZ } from "./tenant";

/**
 * The businesses on this platform: who they are, who is on their team, and their treasury settings.
 *
 * Each business has its own records (lib/store.ts), its own team and its own treasury: a Sputnik DAO it controls, a
 * function-call key for the agent that can only propose payments from it, optionally an OutLayer spending wallet.
 * Secrets (the agent's key, the OutLayer key) are stored encrypted under BLUVFI_MASTER_KEY and decrypted only when
 * that business's request needs them. The operator's own business ('default') takes its settings from the environment.
 */
export interface Member { email: string; role: "owner" | "approver"; addedBy?: string; addedAt?: string }

export interface TreasuryConfig {
  custody: CustodyMode;
  dao?: string;
  agent?: string;
  /** The agent's function-call key, encrypted. */
  agentKey?: string;
  /** OutLayer wallet API key, encrypted. */
  outlayerKey?: string;
  outlayerWallet?: string;
  /** The NEAR account that receives money and is the refund address; the DAO itself when there is one. */
  treasury?: string;
}

/** A business's own outside channels. Each business brings its own bot, phone account and Agent Market worker, so replies and charges stay with it. */
export interface ChannelConfig {
  /** Encrypted. */
  telegramBotToken?: string;
  /** Encrypted; made here and given to Telegram when the webhook is registered. */
  telegramWebhookSecret?: string;
  twilioSid?: string;
  /** Encrypted. */
  twilioToken?: string;
  twilioFrom?: string;
  /** Encrypted. */
  agentMarketToken?: string;
  /** Encrypted; made here, for a scheduler that triggers polling. */
  agentMarketCronSecret?: string;
  /** Encrypted: this business's PingPay key, so what Check earns settles to its own treasury. */
  pingpayKey?: string;
  x402FacilitatorUrl?: string;
}

export interface Business {
  id: string;
  name: string;
  createdAt: string;
  team: Member[];
  treasury?: TreasuryConfig;
  channels?: ChannelConfig;
}

const FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_BUSINESSES_FILE ?? (DEMO ? ".data/demo-businesses.json" : ".data/businesses.json"));
const g = globalThis as unknown as { __bluvfiRegistry?: Map<string, Business> };

function registry(): Map<string, Business> {
  if (g.__bluvfiRegistry) return g.__bluvfiRegistry;
  const map = new Map<string, Business>();
  if (FILE && existsSync(FILE)) {
    try {
      for (const b of JSON.parse(readFileSync(FILE, "utf8")) as Business[]) map.set(b.id, b);
    } catch {
      throw new Error(`Business file ${FILE} is unreadable. Fix or move it; refusing to start empty over it.`);
    }
  }
  return (g.__bluvfiRegistry = map);
}

export function saveRegistry() {
  if (!FILE) return;
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify([...registry().values()]));
  renameSync(tmp, FILE);
}

/** Test helper. */
export const resetRegistry = () => { g.__bluvfiRegistry = new Map(); };

export const businesses = (): Business[] => [...registry().values()];

/** The operator's own business exists from the start; others are made by `createBusiness`. */
export function getBusiness(id: string): Business | undefined {
  const r = registry();
  if (id === DEFAULT_BIZ && !r.has(DEFAULT_BIZ)) r.set(DEFAULT_BIZ, { id: DEFAULT_BIZ, name: COMPANY_NAME, createdAt: new Date(0).toISOString(), team: [] });
  return r.get(id);
}

export const bizName = (id = currentBiz()) => getBusiness(id)?.name ?? "Unknown business";

const EMAIL = /^[^\s@;,"|]+@[^\s@;,"|]+\.[^\s@;,"|]+$/;
export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const validEmail = (e: string) => EMAIL.test(normalizeEmail(e));

/** A new business with `ownerEmail` as its owner. The email is one Privy has verified: the caller must have checked that. */
export function createBusiness(name: string, ownerEmail: string): Business {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 60) throw new Error("Give the business a name of 2 to 60 characters");
  const email = normalizeEmail(ownerEmail);
  if (!validEmail(email)) throw new Error("A valid owner email is needed");
  let id = "";
  do id = `bz_${randomBytes(5).toString("hex")}`; while (registry().has(id) || !BIZ_ID.test(id));
  const b: Business = { id, name: clean, createdAt: new Date().toISOString(), team: [{ email, role: "owner", addedAt: new Date().toISOString() }] };
  registry().set(id, b);
  saveRegistry();
  return b;
}

/** Every business this email belongs to, with their role in each. */
export function businessesFor(email: string, envOwners: string[]): { business: Business; role: Member["role"] }[] {
  const e = normalizeEmail(email);
  const out: { business: Business; role: Member["role"] }[] = [];
  const dflt = getBusiness(DEFAULT_BIZ)!;
  if (envOwners.includes(e)) out.push({ business: dflt, role: "owner" });
  for (const b of registry().values()) {
    const m = b.team.find((x) => x.email === e);
    if (m && !out.some((o) => o.business.id === b.id)) out.push({ business: b, role: m.role });
  }
  return out;
}

const open = (blob?: string) => (blob ? decrypt(blob, dataKey()) : "");

/** What a business has set, with nothing taken from the operator's environment. */
function derive(b: Business | undefined): Cfg {
  const t = b?.treasury;
  const ch = b?.channels;
  const custody = t?.custody ?? "manual";
  const daoCustody = custody === "sputnik" || custody === "hybrid";
  return {
    CUSTODY: custody,
    DAO_ACCOUNT: t?.dao ?? "",
    AGENT_ACCOUNT: t?.agent ?? "",
    AGENT_PRIVATE_KEY: open(t?.agentKey),
    OUTLAYER_API_KEY: open(t?.outlayerKey),
    OUTLAYER_WALLET_ACCOUNT: t?.outlayerWallet ?? "",
    TREASURY_ACCOUNT: t?.treasury || (daoCustody ? (t?.dao ?? "") : ""),
    DAO_CUSTODY: daoCustody,
    POLICY_VIA_DAO: daoCustody && !DEMO && process.env.POLICY_VIA_DAO !== "0",
    TELEGRAM_BOT_TOKEN: open(ch?.telegramBotToken),
    TELEGRAM_WEBHOOK_SECRET: open(ch?.telegramWebhookSecret),
    TWILIO_ACCOUNT_SID: ch?.twilioSid ?? "",
    TWILIO_AUTH_TOKEN: open(ch?.twilioToken),
    TWILIO_FROM: ch?.twilioFrom ?? "",
    AGENT_MARKET_TOKEN: open(ch?.agentMarketToken),
    AGENT_MARKET_CRON_SECRET: open(ch?.agentMarketCronSecret),
    PINGPAY_API_KEY: open(ch?.pingpayKey),
    X402_FACILITATOR_URL: ch?.x402FacilitatorUrl ?? "",
    COMPANY_NAME: b?.name ?? "",
  };
}

/**
 * The treasury settings of the business this request runs in. The operator's own business reads the environment; any
 * other business reads only its own record, and never falls back to the operator's treasury.
 */
export function cfg(): Cfg {
  const biz = currentBiz();
  return biz === DEFAULT_BIZ ? ENV_CFG : derive(getBusiness(biz));
}

/** Save a business's treasury settings. `secrets` are encrypted here; nothing secret is stored in the clear. */
export function setTreasury(id: string, t: { custody: CustodyMode; dao?: string; agent?: string; agentKey?: string; outlayerKey?: string; outlayerWallet?: string; treasury?: string }) {
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  const key = dataKey();
  b.treasury = {
    custody: t.custody,
    dao: t.dao,
    agent: t.agent,
    agentKey: t.agentKey ? encrypt(t.agentKey, key) : undefined,
    outlayerKey: t.outlayerKey ? encrypt(t.outlayerKey, key) : undefined,
    outlayerWallet: t.outlayerWallet,
    treasury: t.treasury,
  };
  saveRegistry();
}

/** Compare two secrets without leaking, through timing, how much of one matches the other. */
export function secretEquals(given: string, secret: string) {
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return !!secret && a.length === b.length && timingSafeEqual(a, b);
}

/** The business a public link names with `?b=<id>` (the operator's own when it names none). Only for public routes: a signed-in session always wins elsewhere. */
export function bizFromRequest(req: Request): string {
  const b = new URL(req.url).searchParams.get("b");
  if (!b || b === DEFAULT_BIZ) return DEFAULT_BIZ;
  if (!BIZ_ID.test(b) || !getBusiness(b)) throw new Error("Unknown business");
  return b;
}

export interface ChannelInput {
  telegramBotToken?: string;
  twilioSid?: string;
  twilioToken?: string;
  twilioFrom?: string;
  agentMarketToken?: string;
  pingpayKey?: string;
  x402FacilitatorUrl?: string;
}

const CHECKS: Record<keyof ChannelInput, [RegExp, string]> = {
  telegramBotToken: [/^\d{6,12}:[\w-]{30,}$/, "That does not look like a Telegram bot token (from @BotFather, like 123456789:AA…)"],
  twilioSid: [/^AC[0-9a-f]{32}$/i, "A Twilio Account SID starts with AC and is 34 characters"],
  twilioToken: [/^[0-9a-f]{32}$/i, "A Twilio auth token is 32 hex characters"],
  twilioFrom: [/^\+\d{7,15}$/, "The Twilio number must be in international format, like +15551234567"],
  agentMarketToken: [/^aat_[\w-]{8,}$/, "An Agent Market token starts with aat_"],
  pingpayKey: [/^\S{8,200}$/, "That does not look like a PingPay API key"],
  x402FacilitatorUrl: [/^https:\/\/[^\s/]+(\/\S*)?$/, "The facilitator must be an https URL"],
};

/** Save a business's channel settings. A value replaces the old one, an empty string clears it, an absent field is kept. Secrets are encrypted here. */
export function setChannels(id: string, input: ChannelInput, generated: { telegramWebhookSecret?: string } = {}): ChannelConfig {
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  const key = dataKey();
  const c: ChannelConfig = { ...(b.channels ?? {}) };
  for (const [field, value] of Object.entries(input) as [keyof ChannelInput, string | undefined][]) {
    if (value === undefined) continue;
    const v = value.trim();
    if (v && !CHECKS[field][0].test(v)) throw new Error(CHECKS[field][1]);
    const secret = field === "telegramBotToken" || field === "twilioToken" || field === "agentMarketToken" || field === "pingpayKey";
    (c as Record<string, string | undefined>)[field] = v ? (secret ? encrypt(v, key) : v) : undefined;
  }
  if (!c.telegramBotToken) c.telegramWebhookSecret = undefined;
  else if (generated.telegramWebhookSecret) c.telegramWebhookSecret = encrypt(generated.telegramWebhookSecret, key);
  if (!c.agentMarketToken) c.agentMarketCronSecret = undefined;
  else if (!c.agentMarketCronSecret) c.agentMarketCronSecret = encrypt(randomBytes(24).toString("hex"), key);
  b.channels = c;
  saveRegistry();
  return c;
}

/** What is set, for the settings page: never a secret, only whether it exists and the plain fields. */
/** `forOwner` adds the cron secret the owner needs to schedule Agent Market polling; no other secret is ever returned. */
export function channelStatus(id: string, forOwner = false) {
  const c = getBusiness(id)?.channels ?? {};
  return {
    cronSecret: forOwner ? open(c.agentMarketCronSecret) : "",
    telegram: !!c.telegramBotToken,
    twilio: !!(c.twilioSid && c.twilioToken && c.twilioFrom),
    twilioSid: c.twilioSid ?? "",
    twilioFrom: c.twilioFrom ?? "",
    agentMarket: !!c.agentMarketToken,
    pingpay: !!c.pingpayKey,
    x402FacilitatorUrl: c.x402FacilitatorUrl ?? "",
  };
}
