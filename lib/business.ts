import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { COMPANY_NAME, DEMO, RAIN_DEFAULT_BASE, demoCfg, envCfgFor, missingConfig, pickCardProvider, type Cfg, type CustodyMode } from "./config";
import { decrypt, encrypt } from "./crypto";
import { dataKey } from "./store";
import { openText, sealText } from "./vault";
import { fileStamp, withFileLockSync, writeAtomic } from "./shared-file";
import type { KybRecord, PassportRecord } from "./types";
import { BIZ_ID, currentBiz, DEFAULT_BIZ, isDemo } from "./tenant";

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
  /** The DAO's funds are shielded in Confidential Intents and payouts go out through the MPC signer. */
  confidential?: boolean;
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
  /** The business's own card-issuing account for one-time cards (lib/cards.ts). Which one, when several are set. */
  cardProvider?: string;
  /** Encrypted. */
  stripeKey?: string;
  stripeCardholder?: string;
  /** Encrypted: Stripe's signing secret for this business's real-time authorization webhook. */
  stripeWebhookSecret?: string;
  rampClientId?: string;
  /** Encrypted. */
  rampClientSecret?: string;
  rampUserId?: string;
  /** "1" for Ramp's sandbox. */
  rampSandbox?: string;
  /** Encrypted. */
  rainKey?: string;
  rainUserId?: string;
  rainPublicKey?: string;
  rainBaseUrl?: string;
  /** Encrypted. Credible Finance (INR bank transfers). */
  credibleKey?: string;
  /** Encrypted. */
  credibleSecret?: string;
  /** Encrypted. Backpack Exchange (stocks). */
  backpackKey?: string;
  /** Encrypted: the base64 ED25519 seed. */
  backpackSecret?: string;
}

export interface Business {
  id: string;
  name: string;
  createdAt: string;
  team: Member[];
  treasury?: TreasuryConfig;
  channels?: ChannelConfig;
  /** This business's own identity verification (lib/kyb.ts). */
  kyb?: KybRecord;
  /** An owner's passport proof for this business (lib/passport.ts), which the council may accept instead. */
  passport?: PassportRecord;
  /** This business's own backups, to its own S3-compatible bucket (lib/business-backup.ts). */
  backup?: BusinessBackupConfig;
}

export interface BusinessBackupConfig {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  /** Encrypted. */
  secretAccessKey: string;
  /** Encrypted. The passphrase the backups are encrypted with; the business keeps it too, to open them without this platform. */
  passphrase: string;
  status?: { lastAttemptAt?: string; lastOkAt?: string; lastName?: string; lastBytes?: number; error?: string };
}

const FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_BUSINESSES_FILE ?? (DEMO ? ".data/demo-businesses.json" : ".data/businesses.json"));
// Several instances may share this file (lib/shared-file.ts): each re-reads it when another has written it, and a save writes
// only the businesses this instance changed, on top of what is on disk, under a lock.
const g = globalThis as unknown as { __bluvfiRegistry?: Map<string, Business>; __bluvfiRegistryMeta?: { stamp: string; checkedAt: number; seen: Map<string, string> } };
const meta = () => (g.__bluvfiRegistryMeta ??= { stamp: "", checkedAt: 0, seen: new Map() });
const RECHECK_MS = 500;

function readRegistryFile(): { map: Map<string, Business>; legacy: boolean } {
  const map = new Map<string, Business>();
  if (!FILE || !existsSync(FILE)) return { map, legacy: false };
  try {
    const stamp = fileStamp(FILE);
    const { text, legacy } = openText(readFileSync(FILE, "utf8"));
    for (const b of JSON.parse(text) as Business[]) map.set(b.id, b);
    meta().stamp = stamp;
    return { map, legacy };
  } catch {
    throw new Error(`Business file ${FILE} is unreadable (or BLUVFI_MASTER_KEY is not the key it was sealed with). Fix or move it; refusing to start empty over it.`);
  }
}

function adopt(map: Map<string, Business>) {
  meta().seen = new Map([...map].map(([id, b]) => [id, JSON.stringify(b)]));
  return (g.__bluvfiRegistry = map);
}

function registry(): Map<string, Business> {
  const m = meta();
  if (g.__bluvfiRegistry) {
    if (!FILE || Date.now() - m.checkedAt < RECHECK_MS) return g.__bluvfiRegistry;
    m.checkedAt = Date.now();
    const now = fileStamp(FILE);
    if (!now || now === m.stamp) return g.__bluvfiRegistry;
  }
  const { map, legacy } = readRegistryFile();
  m.checkedAt = Date.now();
  adopt(map);
  if (legacy) {
    m.seen.clear();
    saveRegistry();
  }
  return g.__bluvfiRegistry!;
}

export function saveRegistry() {
  if (!FILE) return;
  // Not registry(): re-reading here would drop the change the caller just made.
  const mine = g.__bluvfiRegistry ?? registry();
  withFileLockSync(FILE, () => {
    const { map: disk } = readRegistryFile();
    for (const [id, b] of mine) if (meta().seen.get(id) !== JSON.stringify(b)) disk.set(id, b);
    writeAtomic(FILE, sealText(JSON.stringify([...disk.values()])));
    meta().stamp = fileStamp(FILE);
    meta().checkedAt = Date.now();
    adopt(disk);
  });
}

/** Record an owner's passport proof for this business (lib/passport.ts). */
export function setBusinessPassport(id: string, passport: PassportRecord): PassportRecord {
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  b.passport = passport;
  saveRegistry();
  return passport;
}

export function setBusinessKyb(id: string, kyb: KybRecord): KybRecord {
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  b.kyb = kyb;
  saveRegistry();
  return kyb;
}

/** Test helper. */
export const resetRegistry = () => { adopt(new Map()); };

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
    POLICY_VIA_DAO: daoCustody && process.env.POLICY_VIA_DAO !== "0",
    CONFIDENTIAL: daoCustody && !!t?.confidential,
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
    CARD_PROVIDER: ch?.cardProvider ?? "",
    STRIPE_SECRET_KEY: open(ch?.stripeKey),
    STRIPE_CARDHOLDER_ID: ch?.stripeCardholder ?? "",
    STRIPE_WEBHOOK_SECRET: open(ch?.stripeWebhookSecret),
    RAMP_CLIENT_ID: ch?.rampClientId ?? "",
    RAMP_CLIENT_SECRET: open(ch?.rampClientSecret),
    RAMP_USER_ID: ch?.rampUserId ?? "",
    RAMP_SANDBOX: ch?.rampSandbox === "1",
    RAIN_API_KEY: open(ch?.rainKey),
    RAIN_USER_ID: ch?.rainUserId ?? "",
    RAIN_SECRETS_PUBLIC_KEY: ch?.rainPublicKey ?? "",
    RAIN_BASE_URL: ch?.rainBaseUrl || RAIN_DEFAULT_BASE,
    CREDIBLE_API_KEY: open(ch?.credibleKey),
    CREDIBLE_API_SECRET: open(ch?.credibleSecret),
    BACKPACK_API_KEY: open(ch?.backpackKey),
    BACKPACK_API_SECRET: open(ch?.backpackSecret),
  };
}

/**
 * The treasury settings of the business this request runs in. The operator's own business reads the environment; any
 * other business reads only its own record, and never falls back to the operator's treasury.
 */
export function cfg(): Cfg {
  if (isDemo()) return demoCfg();
  const biz = currentBiz();
  return biz === DEFAULT_BIZ ? envCfgFor(false) : derive(getBusiness(biz));
}

/** What this business still lacks to run, by its own settings and mode (the demo needs nothing). */
export const missingHere = () => missingConfig(cfg(), currentBiz() !== DEFAULT_BIZ, isDemo());

/** A business's settings as live, whichever mode it is in now: what going live would run on. */
export function liveCfg(biz: string): Cfg {
  return biz === DEFAULT_BIZ ? envCfgFor(false) : derive(getBusiness(biz));
}

/** Turn a business's confidential treasury on or off. It needs a DAO: shielded funds are spent by a council-approved MPC signature. */
export function setConfidential(id: string, on: boolean) {
  const b = getBusiness(id);
  if (!b?.treasury) throw new Error("Set up the treasury first");
  if (on && b.treasury.custody !== "sputnik") throw new Error("A confidential treasury needs a Sputnik DAO");
  b.treasury.confidential = on;
  saveRegistry();
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
  cardProvider?: string;
  stripeKey?: string;
  stripeCardholder?: string;
  stripeWebhookSecret?: string;
  rampClientId?: string;
  rampClientSecret?: string;
  rampUserId?: string;
  rampSandbox?: string;
  rainKey?: string;
  rainUserId?: string;
  rainPublicKey?: string;
  rainBaseUrl?: string;
  credibleKey?: string;
  credibleSecret?: string;
  backpackKey?: string;
  backpackSecret?: string;
}

/** The channel fields that are secrets: stored encrypted, never sent back. */
const SECRET_FIELDS = new Set<keyof ChannelInput>(["telegramBotToken", "twilioToken", "agentMarketToken", "pingpayKey", "stripeKey", "stripeWebhookSecret", "rampClientSecret", "rainKey", "credibleKey", "credibleSecret", "backpackKey", "backpackSecret"]);
export const CHANNEL_FIELDS = [
  "telegramBotToken", "twilioSid", "twilioToken", "twilioFrom", "agentMarketToken", "pingpayKey", "x402FacilitatorUrl",
  "cardProvider", "stripeKey", "stripeCardholder", "stripeWebhookSecret", "rampClientId", "rampClientSecret", "rampUserId", "rampSandbox",
  "rainKey", "rainUserId", "rainPublicKey", "rainBaseUrl", "credibleKey", "credibleSecret", "backpackKey", "backpackSecret",
] as const satisfies readonly (keyof ChannelInput)[];

const CHECKS: Record<keyof ChannelInput, [RegExp, string]> = {
  telegramBotToken: [/^\d{6,12}:[\w-]{30,}$/, "That does not look like a Telegram bot token (from @BotFather, like 123456789:AA…)"],
  twilioSid: [/^AC[0-9a-f]{32}$/i, "A Twilio Account SID starts with AC and is 34 characters"],
  twilioToken: [/^[0-9a-f]{32}$/i, "A Twilio auth token is 32 hex characters"],
  twilioFrom: [/^\+\d{7,15}$/, "The Twilio number must be in international format, like +15551234567"],
  agentMarketToken: [/^aat_[\w-]{8,}$/, "An Agent Market token starts with aat_"],
  pingpayKey: [/^\S{8,200}$/, "That does not look like a PingPay API key"],
  x402FacilitatorUrl: [/^https:\/\/[^\s/]+(\/\S*)?$/, "The facilitator must be an https URL"],
  cardProvider: [/^(stripe|ramp|rain)$/, "The card provider must be stripe, ramp or rain"],
  stripeKey: [/^(sk|rk)_(test|live)_[\w]{10,}$/, "A Stripe secret key starts with sk_test_, sk_live_ or rk_ (a restricted key)"],
  stripeCardholder: [/^ich_[\w]{6,}$/, "A Stripe cardholder id starts with ich_"],
  stripeWebhookSecret: [/^whsec_[\w+/=]{10,}$/, "A Stripe webhook signing secret starts with whsec_"],
  rampClientId: [/^[\w-]{6,200}$/, "That does not look like a Ramp client id"],
  rampClientSecret: [/^\S{8,300}$/, "That does not look like a Ramp client secret"],
  rampUserId: [/^[\w-]{6,80}$/, "That does not look like a Ramp user id"],
  rampSandbox: [/^[01]$/, "Ramp sandbox is 1 (on) or 0 (off)"],
  rainKey: [/^\S{8,300}$/, "That does not look like a Rain API key"],
  rainUserId: [/^[\w-]{6,80}$/, "That does not look like a Rain user id"],
  rainPublicKey: [/^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----$/, "Paste Rain's public key as PEM, from -----BEGIN PUBLIC KEY----- to -----END PUBLIC KEY-----"],
  rainBaseUrl: [/^https:\/\/[^\s/]+(\/\S*)?$/, "Rain's API address must be an https URL"],
  credibleKey: [/^\S{8,300}$/, "That does not look like a Credible Finance API key"],
  credibleSecret: [/^\S{8,300}$/, "That does not look like a Credible Finance API secret"],
  backpackKey: [/^\S{8,200}$/, "That does not look like a Backpack API key"],
  backpackSecret: [/^[A-Za-z0-9+/]{43}=$/, "A Backpack API secret is a base64 text of 44 characters, ending in ="],
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
    const secret = SECRET_FIELDS.has(field);
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
    backpack: (() => { const d = liveCfg(id); return !!(d.BACKPACK_API_KEY && d.BACKPACK_API_SECRET); })(),
    credible: (() => { const d = liveCfg(id); return !!(d.CREDIBLE_API_KEY && d.CREDIBLE_API_SECRET); })(),
    // Cards: which provider is ready, and the plain fields; secrets only as "set".
    // Cards: which provider is ready, and the plain fields; secrets only as "set". The operator's own business reads its environment.
    cards: (() => {
      const env = id === DEFAULT_BIZ;
      const d = liveCfg(id);
      return {
        fromEnv: env,
        provider: pickCardProvider(d),
        asked: d.CARD_PROVIDER,
        stripe: !!(d.STRIPE_SECRET_KEY && d.STRIPE_CARDHOLDER_ID), stripeCardholder: d.STRIPE_CARDHOLDER_ID, stripeWebhook: !!d.STRIPE_WEBHOOK_SECRET,
        stripeTest: /^(sk|rk)_test_/.test(d.STRIPE_SECRET_KEY),
        ramp: !!(d.RAMP_CLIENT_ID && d.RAMP_CLIENT_SECRET && d.RAMP_USER_ID), rampClientId: d.RAMP_CLIENT_ID, rampUserId: d.RAMP_USER_ID, rampSandbox: d.RAMP_SANDBOX,
        rain: !!(d.RAIN_API_KEY && d.RAIN_USER_ID && d.RAIN_SECRETS_PUBLIC_KEY), rainUserId: d.RAIN_USER_ID, rainBaseUrl: env ? d.RAIN_BASE_URL : (c.rainBaseUrl ?? ""), rainPublicKey: !!d.RAIN_SECRETS_PUBLIC_KEY,
      };
    })(),
  };
}
