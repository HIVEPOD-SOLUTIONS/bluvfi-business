import { readFileSync } from "node:fs";

/**
 * Mainnet by default: every service below is the real one, and anything that is not configured makes the
 * affected feature refuse to run (see `missingConfig`).
 *
 * BLUVFI_DEMO=1 (`npm run demo`) swaps the outside services for recorded fixtures (lib/demo.ts) and fills in
 * throwaway keys, so the whole flow runs with no keys and no funds. Verification still runs on the fixtures.
 */
export const DEMO = process.env.BLUVFI_DEMO === "1";
/** BLUVFI_NETWORK=testnet points the NEAR side (RPC, account names, OutLayer) at testnet, for the real-chain test suite. 1Click, NEAR AI Cloud and NRAS have no testnet. */
export const NETWORK: "mainnet" | "testnet" = process.env.BLUVFI_NETWORK === "testnet" ? "testnet" : "mainnet";
export const NEAR_SUFFIX = NETWORK === "testnet" ? "testnet" : "near";
const NEAR_ACCOUNT = new RegExp(`\\.${NEAR_SUFFIX}$`);
const NEAR_ACCOUNT_OR_IMPLICIT = new RegExp(`\\.${NEAR_SUFFIX}$|^[0-9a-f]{64}$`);

/** Throwaway values for demo mode only; never used when BLUVFI_DEMO is off. */
export const DEMO_DEFAULTS = {
  BLUVFI_MASTER_KEY: "de".repeat(32),
  BLUVFI_SIGNERS: "maya:demo-signer-maya-token,devon:demo-signer-devon-token",
  TREASURY_ACCOUNT: "bluvfi-demo.near",
};
const env = (key: keyof typeof DEMO_DEFAULTS) => process.env[key] ?? (DEMO ? DEMO_DEFAULTS[key] : "");

export const NEAR_AI_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE = process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1";
/**
 * The canonical model id. NEAR AI Cloud renames models and keeps the old names as aliases; we ask for no aliasing
 * (lib/nearai.ts), so an old name is refused with a 400 instead of quietly attesting a different model.
 */
export const DEFAULT_NEAR_AI_MODEL = "z-ai/glm-5.3-flash";
export const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL || DEFAULT_NEAR_AI_MODEL;
/** The model name the demo's recorded reviews were made for. Fixed, so a model set in .env.local never breaks the demo replays. */
export const DEMO_AI_MODEL = DEFAULT_NEAR_AI_MODEL;

export const NEAR_RPC_URL = process.env.NEAR_RPC_URL ?? (NETWORK === "testnet" ? "https://test.rpc.fastnear.com" : "https://rpc.mainnet.near.org");
/** Archival NEAR RPC: old blocks, to tell whether a payee's contract code changed recently. */
export const NEAR_ARCHIVAL_RPC_URL = process.env.NEAR_ARCHIVAL_RPC_URL ?? (NETWORK === "testnet" ? "https://archival-rpc.testnet.fastnear.com" : "https://archival-rpc.mainnet.fastnear.com");
export const EVM_RPC_URL = process.env.EVM_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

export const ONECLICK_BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
export const ONECLICK_JWT = process.env.ONECLICK_JWT ?? "";
/** Aurora Widget Studio key (studio.aurora.dev) for the pay-link wallet widget. Aurora documents it as public. */
export const AURORA_API_KEY = process.env.AURORA_API_KEY ?? "";
/** ONECLICK_DRY=1: ask 1Click for dry-run quotes only (real prices, no deposit address), so nothing can be paid. For judging and testing. */
export const ONECLICK_DRY = process.env.ONECLICK_DRY === "1";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
export const TWILIO_FROM = process.env.TWILIO_FROM ?? "";
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
export const COMPANY_NAME = process.env.COMPANY_NAME ?? "our finance team";

export const NEARBLOCKS_BASE = process.env.NEARBLOCKS_BASE_URL ?? "https://api.nearblocks.io";
export const NEARBLOCKS_KEY = process.env.NEARBLOCKS_API_KEY ?? "";

/** Agent Market worker: aat_ token from your agent page; the cron secret lets a scheduler trigger polling. */
export const AGENT_MARKET_BASE = (process.env.AGENT_MARKET_BASE_URL ?? "https://market.near.ai").replace(/\/$/, "");
export const AGENT_MARKET_TOKEN = process.env.AGENT_MARKET_TOKEN ?? "";
/** A scheduler that sends this as a bearer token to /api/settlement/poll checks every business's open payments and invoices. */
export const SETTLEMENT_CRON_SECRET = process.env.SETTLEMENT_CRON_SECRET ?? "";
export const AGENT_MARKET_CRON_SECRET = process.env.AGENT_MARKET_CRON_SECRET ?? "";

/** PingPay Agent Pay facilitator for selling Check over x402 (buyers pay USDC on Base, we receive USDC on NEAR). */
export const PINGPAY_API_KEY = process.env.PINGPAY_API_KEY ?? "";
export const PINGPAY_BASE = (process.env.PINGPAY_BASE_URL ?? "https://pay.pingpay.io").replace(/\/$/, "");
export const X402_FACILITATOR_URL = (process.env.X402_FACILITATOR_URL ?? "").replace(/\/$/, "");
/** A service that signs an x402 payment for the agent, so this app never holds a payment key. */
/** The payer service's shared secret, sent as a bearer token so only this app can ask it to sign. */
export const X402_PAYER_TOKEN = process.env.X402_PAYER_TOKEN ?? "";
/** X402_TESTNET=1: the agent may also pay in USDC on Base Sepolia, so the whole spending path can be run for real with free test tokens. */
export const X402_TESTNET = process.env.X402_TESTNET === "1";
/** With X402_TESTNET=1 and this EVM address, Check can also be paid in free Base Sepolia test USDC, through the public x402.org facilitator, so selling it can be run for real. */
export const X402_PAYTO_EVM = process.env.X402_PAYTO_EVM ?? "";
export const X402_PAYER_URL = (process.env.X402_PAYER_URL ?? "").replace(/\/$/, "");

/**
 * Custody: who holds the funds, and so what the agent may do with them. Never this app.
 *  - sputnik: a Sputnik DAO v2 treasury (the contract Trezu runs on). The agent's NEAR key is a function-call key
 *    that may only call `add_proposal` on the DAO, so it can propose a payout and nothing else; council members vote.
 *  - outlayer: an OutLayer agent wallet. Its owner-set policy (limits, allowlist, multisig, freeze) is enforced in
 *    Intel TDX; the agent holds only an API key.
 *  - hybrid: both. The DAO is the vault; an OutLayer wallet holds a small working balance the agent pays routine
 *    invoices from, under OutLayer's limits. Payments at or over the approval threshold, or larger than the wallet
 *    holds, go to the DAO for a council vote, and the agent asks the DAO to top the wallet up when it runs low.
 *  - manual: no custody integration; a signer sends from their own wallet and records the transaction.
 */
export const DAO_ACCOUNT = process.env.DAO_ACCOUNT ?? (DEMO ? "bluvfi-demo.sputnik-dao.near" : "");
export const AGENT_ACCOUNT = process.env.AGENT_ACCOUNT ?? "";
/** `ed25519:…` (or `ml-dsa-65:…`, post-quantum) secret of the agent's function-call key. */
export const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY ?? "";
/** Pays gas for council votes sent as NEP-366 meta transactions (only `act_proposal` on DAO_ACCOUNT). */
export const RELAYER_ACCOUNT = process.env.RELAYER_ACCOUNT ?? "";
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? "";
/** Privy app ID (https://dashboard.privy.io): lets /setup pay with an email or Google login instead of a NEAR wallet. Public by design. */
export const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? "";
/** Privy app secret (server only, never sent to the browser): lets the server read a signed-in person's verified email. */
export const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";
/** Owners of the operator's own business (the default one). Businesses that sign up make their own owner. */
export const OWNER_EMAILS = (process.env.BLUVFI_OWNER_EMAIL ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
/** Sign in with Privy, and business signup, need the app ID and the secret. */
export const PRIVY_LOGIN = !!PRIVY_APP_ID && !!PRIVY_APP_SECRET;
/** BLUVFI_SIGNUP=closed stops new businesses from signing up (existing ones keep working). */
export const SIGNUP_OPEN = PRIVY_LOGIN && process.env.BLUVFI_SIGNUP !== "closed";
export const TREZU_APP_URL = (process.env.TREZU_APP_URL ?? "https://trezu.app").replace(/\/$/, "");
export const OUTLAYER_BASE = (process.env.OUTLAYER_BASE_URL ?? (NETWORK === "testnet" ? "https://testnet-api.outlayer.ai" : "https://api.outlayer.ai")).replace(/\/$/, "");
export const OUTLAYER_API_KEY = process.env.OUTLAYER_API_KEY ?? "";
/** Hybrid custody: the OutLayer wallet's NEAR account, which the DAO tops up and whose USDC balance is read from the chain. */
export const OUTLAYER_WALLET_ACCOUNT = process.env.OUTLAYER_WALLET_ACCOUNT ?? "";
/** Hybrid custody: ask the DAO for a top-up below this USDC balance, up to the target (defaults: the daily limit, and twice it). */
export const SPENDING_WALLET_LOW_USD = Number(process.env.SPENDING_WALLET_LOW_USD ?? 0) || undefined;
export const SPENDING_WALLET_TARGET_USD = Number(process.env.SPENDING_WALLET_TARGET_USD ?? 0) || undefined;
export type CustodyMode = "sputnik" | "outlayer" | "hybrid" | "manual";
export const CUSTODY: CustodyMode =
  DEMO ? "sputnik"
  : process.env.CUSTODY === "sputnik" || process.env.CUSTODY === "outlayer" || process.env.CUSTODY === "hybrid" || process.env.CUSTODY === "manual" ? process.env.CUSTODY
  : DAO_ACCOUNT && AGENT_ACCOUNT && AGENT_PRIVATE_KEY ? "sputnik"
  : OUTLAYER_API_KEY ? "outlayer"
  : "manual";
/** Sputnik or hybrid custody: the treasury is a DAO, so the council approves payouts and policy changes. */
export const DAO_CUSTODY = CUSTODY === "sputnik" || CUSTODY === "hybrid";
/** With Sputnik custody, policy changes are approved by the DAO council (a carrier proposal), not by app signers. POLICY_VIA_DAO=0 opts out. */
/**
 * With OutLayer custody, refuse payouts while the custodian lacks a per-payment or daily limit, or has a looser one, than
 * this app's policy. On by default: the OutLayer API key can spend from the wallet up to OutLayer's own limits, so those
 * limits are what bound a leaked key. REQUIRE_CUSTODIAN_LIMITS=0 turns it off.
 */
export const REQUIRE_CUSTODIAN_LIMITS = process.env.REQUIRE_CUSTODIAN_LIMITS !== "0";
export const POLICY_VIA_DAO = DAO_CUSTODY && !DEMO && process.env.POLICY_VIA_DAO !== "0";

/** NEAR mainnet account that receives money and is the 1Click refund address. With a DAO, the DAO itself. */
export const TREASURY_ACCOUNT = env("TREASURY_ACCOUNT") || (DAO_CUSTODY ? DAO_ACCOUNT : "");
/**
 * The master key decrypts every business's stored secrets (agent keys, OutLayer and PingPay keys), so it is the one secret
 * to keep out of ordinary files. BLUVFI_MASTER_KEY_FILE names a file holding it, such as a Docker or Kubernetes secret
 * mounted read-only, or one a cloud secrets manager writes at boot; it wins over BLUVFI_MASTER_KEY.
 */
function masterKey(): string {
  const file = process.env.BLUVFI_MASTER_KEY_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (e) {
      throw new Error(`BLUVFI_MASTER_KEY_FILE is set but ${file} cannot be read: ${(e as Error).message}`);
    }
  }
  return env("BLUVFI_MASTER_KEY");
}
export const MASTER_KEY = masterKey();
/** Where the master key came from: a secrets file, the environment (which includes .env.local), or nowhere. */
export const MASTER_KEY_SOURCE: "file" | "env" | "none" = process.env.BLUVFI_MASTER_KEY_FILE ? "file" : MASTER_KEY ? "env" : "none";

/** `BLUVFI_SIGNERS="maya:token1,devon:token2"`: who may approve, and the secret each signs in with. */
export const SIGNERS: { name: string; token: string }[] = env("BLUVFI_SIGNERS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(":");
    return { name: s.slice(0, i), token: s.slice(i + 1) };
  })
  .filter((s) => s.name && s.token.length >= 16);
export const SIGNER_NAMES = SIGNERS.map((s) => s.name);
export const APPROVAL_THRESHOLD_SIGNERS = Math.max(1, Math.min(Number(process.env.APPROVAL_THRESHOLD_SIGNERS ?? 2), SIGNERS.length || 1));

/**
 * The settings that belong to one business's treasury. For the operator's own business they come from the environment,
 * as here; for a business that signed up on the platform they come from its record (lib/business.ts cfg()). Code that
 * serves a business reads them through cfg(), never from these constants directly.
 */
/**
 * One-time cards for the agent (lib/cards.ts): the agent buys from an ordinary card checkout with a virtual card issued for that one
 * purchase, capped at its amount, and closed after it. Every business uses its own card-issuing account: a business that signed up sets
 * its keys on the Settings page (stored encrypted); the operator's own business reads them from here. One provider per business:
 *  - Stripe Issuing: STRIPE_SECRET_KEY (sk_test_... to try it), STRIPE_CARDHOLDER_ID (ich_..., the company cardholder the cards belong to),
 *    and STRIPE_WEBHOOK_SECRET (whsec_...) for real-time authorizations: point Issuing's authorization webhook at
 *    PUBLIC_BASE_URL/api/cards/stripe (a signed-up business adds ?b=<its id>; the Settings page shows its URL), and every charge on a card is
 *    approved or declined here, against the purchase it was made for.
 *  - Ramp Agent Cards (Vault API): RAMP_CLIENT_ID, RAMP_CLIENT_SECRET, RAMP_USER_ID (whose funds the card draws on); RAMP_SANDBOX=1 for Ramp's sandbox.
 *  - Rain (cards backed by stablecoin collateral): RAIN_API_KEY, RAIN_USER_ID, RAIN_SECRETS_PUBLIC_KEY (Rain's PEM key for reading card
 *    numbers), RAIN_BASE_URL (default production; https://api-dev.raincards.xyz/v1 for the sandbox).
 * CARD_PROVIDER picks one when more than one is set. CARD_TTL_HOURS: an unused card is closed after this many hours (default 24).
 */
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_CARDHOLDER_ID = process.env.STRIPE_CARDHOLDER_ID ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
export const STRIPE_API_BASE = process.env.STRIPE_API_BASE || "https://api.stripe.com";
export const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || "2025-03-31.basil";
export const RAMP_CLIENT_ID = process.env.RAMP_CLIENT_ID ?? "";
export const RAMP_CLIENT_SECRET = process.env.RAMP_CLIENT_SECRET ?? "";
export const RAMP_USER_ID = process.env.RAMP_USER_ID ?? "";
export const RAMP_SANDBOX = process.env.RAMP_SANDBOX === "1";
/** Ramp's API and Vault hosts, production or sandbox (RAMP_API_BASE and RAMP_VAULT_BASE override both, for tests). */
export const rampBases = (sandbox: boolean) => ({
  api: process.env.RAMP_API_BASE || (sandbox ? "https://demo-api.ramp.com" : "https://api.ramp.com"),
  vault: process.env.RAMP_VAULT_BASE || (sandbox ? "https://demo-vault-api.ramp.com" : "https://vault-api.ramp.com"),
});
export const RAIN_API_KEY = process.env.RAIN_API_KEY ?? "";
export const RAIN_USER_ID = process.env.RAIN_USER_ID ?? "";
export const RAIN_SECRETS_PUBLIC_KEY = (process.env.RAIN_SECRETS_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
export const RAIN_DEFAULT_BASE = "https://api.raincards.xyz/v1";
export const RAIN_BASE_URL = process.env.RAIN_BASE_URL || RAIN_DEFAULT_BASE;
export type CardProviderName = "stripe" | "ramp" | "rain" | "";
/** Which provider a business's card settings point to: the one asked for if it is fully set, else the first that is. */
export function pickCardProvider(c: {
  CARD_PROVIDER?: string; STRIPE_SECRET_KEY: string; STRIPE_CARDHOLDER_ID: string; RAMP_CLIENT_ID: string; RAMP_CLIENT_SECRET: string; RAMP_USER_ID: string;
  RAIN_API_KEY: string; RAIN_USER_ID: string; RAIN_SECRETS_PUBLIC_KEY: string;
}): CardProviderName {
  const ready = {
    stripe: !!(c.STRIPE_SECRET_KEY && c.STRIPE_CARDHOLDER_ID),
    ramp: !!(c.RAMP_CLIENT_ID && c.RAMP_CLIENT_SECRET && c.RAMP_USER_ID),
    rain: !!(c.RAIN_API_KEY && c.RAIN_USER_ID && c.RAIN_SECRETS_PUBLIC_KEY),
  };
  const asked = c.CARD_PROVIDER as keyof typeof ready | undefined;
  if (asked && ready[asked]) return asked;
  return ready.stripe ? "stripe" : ready.ramp ? "ramp" : ready.rain ? "rain" : "";
}
export const CARD_PROVIDER = process.env.CARD_PROVIDER ?? "";
/** Credible Finance (INR bank transfers in and out): the operator's own business reads these; every other business brings its own. */
export const CREDIBLE_API_KEY = process.env.CREDIBLE_FINANCE_API_KEY ?? "";
export const CREDIBLE_API_SECRET = process.env.CREDIBLE_FINANCE_API_SECRET ?? "";
/** Backpack Exchange (US stocks and ETFs): the operator's own business reads these; every other business brings its own account. */
export const BACKPACK_API_KEY = process.env.BACKPACK_API_KEY ?? "";
export const BACKPACK_API_SECRET = process.env.BACKPACK_API_SECRET ?? "";
export const CARD_TTL_HOURS = Math.max(1, Number(process.env.CARD_TTL_HOURS ?? 24) || 24);

/** CONFIDENTIAL_TREASURY=1: the DAO's funds are shielded in Confidential Intents, and payouts go out through the MPC signer (lib/confidential-flow.ts). Needs Sputnik custody. */
export const CONFIDENTIAL = process.env.CONFIDENTIAL_TREASURY === "1";

export const ENV_CFG = {
  CONFIDENTIAL, CUSTODY, DAO_ACCOUNT, AGENT_ACCOUNT, AGENT_PRIVATE_KEY, OUTLAYER_API_KEY, OUTLAYER_WALLET_ACCOUNT, TREASURY_ACCOUNT, DAO_CUSTODY, POLICY_VIA_DAO,
  // The business's own channels and what it charges for Check. A business that signed up brings its own bot, phone account and facilitator.
  TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, AGENT_MARKET_TOKEN, AGENT_MARKET_CRON_SECRET,
  PINGPAY_API_KEY, X402_FACILITATOR_URL, COMPANY_NAME,
  // The business's own card-issuing account (lib/cards.ts).
  CARD_PROVIDER, STRIPE_SECRET_KEY, STRIPE_CARDHOLDER_ID, STRIPE_WEBHOOK_SECRET, RAMP_CLIENT_ID, RAMP_CLIENT_SECRET, RAMP_USER_ID, RAMP_SANDBOX,
  RAIN_API_KEY, RAIN_USER_ID, RAIN_SECRETS_PUBLIC_KEY, RAIN_BASE_URL,
  CREDIBLE_API_KEY, CREDIBLE_API_SECRET, BACKPACK_API_KEY, BACKPACK_API_SECRET,
};
export type Cfg = typeof ENV_CFG;

/**
 * The operator's own business as demo or as live, whichever way this copy was started. The values that differ are the DAO, custody and
 * treasury (demo fills in a simulated DAO and treasury); everything else is read from the environment either way.
 */
export function envCfgFor(demo: boolean): Cfg {
  if (demo === DEMO) return ENV_CFG;
  const dao = process.env.DAO_ACCOUNT ?? (demo ? "bluvfi-demo.sputnik-dao.near" : "");
  const asked = process.env.CUSTODY;
  const custody: CustodyMode = demo ? "sputnik"
    : asked === "sputnik" || asked === "outlayer" || asked === "hybrid" || asked === "manual" ? asked
    : dao && AGENT_ACCOUNT && AGENT_PRIVATE_KEY ? "sputnik" : OUTLAYER_API_KEY ? "outlayer" : "manual";
  const daoCustody = custody === "sputnik" || custody === "hybrid";
  const treasury = (process.env.TREASURY_ACCOUNT ?? (demo ? DEMO_DEFAULTS.TREASURY_ACCOUNT : "")) || (daoCustody ? dao : "");
  return { ...ENV_CFG, DAO_ACCOUNT: dao, CUSTODY: custody, DAO_CUSTODY: daoCustody, POLICY_VIA_DAO: daoCustody && !demo && process.env.POLICY_VIA_DAO !== "0", TREASURY_ACCOUNT: treasury };
}

/**
 * What a business running in demo uses: the simulated DAO and treasury, and no key of anyone's, so nothing in demo can reach a real account.
 * (The services themselves are the fixtures in lib/demo.ts.)
 */
export function demoCfg(): Cfg {
  const d = envCfgFor(true);
  const blank = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" ? "" : v])) as unknown as Cfg;
  return { ...blank, CUSTODY: "sputnik", DAO_ACCOUNT: "bluvfi-demo.sputnik-dao.near", TREASURY_ACCOUNT: DEMO_DEFAULTS.TREASURY_ACCOUNT, DAO_CUSTODY: true, POLICY_VIA_DAO: false, RAIN_BASE_URL: d.RAIN_BASE_URL, COMPANY_NAME: d.COMPANY_NAME };
}

/** What must be set before the app can do its job. Shown on Overview; features refuse to run without it. */
export function missingConfig(c: Cfg = ENV_CFG, tenant = false, demo = DEMO): { key: string; why: string }[] {
  const { CUSTODY, DAO_ACCOUNT, AGENT_ACCOUNT, AGENT_PRIVATE_KEY, OUTLAYER_API_KEY, OUTLAYER_WALLET_ACCOUNT, TREASURY_ACCOUNT, DAO_CUSTODY } = c;
  const out: { key: string; why: string }[] = [];
  const need = (ok: boolean, key: string, why: string) => ok || out.push({ key, why });
  need(tenant || /^[0-9a-f]{64}$/i.test(MASTER_KEY), "BLUVFI_MASTER_KEY", "64 hex characters; derives the record encryption and signing keys");
  need(tenant || SIGNERS.length > 0 || PRIVY_LOGIN, "BLUVFI_SIGNERS", "name:token pairs (token 16+ characters) for the people who can approve, or set PRIVY_APP_ID, PRIVY_APP_SECRET and BLUVFI_OWNER_EMAIL to sign in with Privy");
  need(NEAR_ACCOUNT_OR_IMPLICIT.test(TREASURY_ACCOUNT), "TREASURY_ACCOUNT", `your NEAR ${NETWORK} account (name.${NEAR_SUFFIX} or a 64-hex implicit account)`);
  need(tenant || !!NEAR_AI_KEY || demo, "NEAR_AI_API_KEY", "private AI review; without it every payment is held for a human");
  if (DAO_CUSTODY && !demo) {
    need(NEAR_ACCOUNT.test(DAO_ACCOUNT), "DAO_ACCOUNT", "your Sputnik DAO / Trezu treasury, e.g. acme.sputnik-dao.near");
    need(!!AGENT_ACCOUNT, "AGENT_ACCOUNT", "the NEAR account the agent proposes from");
    need(/^(ed25519|ml-dsa-65):/.test(AGENT_PRIVATE_KEY), "AGENT_PRIVATE_KEY", "the agent's function-call key, scoped to add_proposal on the DAO");
  }
  if (CUSTODY === "hybrid" && !demo) {
    need(!!OUTLAYER_API_KEY, "OUTLAYER_API_KEY", "the agent's API key for the OutLayer spending wallet");
    need(NEAR_ACCOUNT_OR_IMPLICIT.test(OUTLAYER_WALLET_ACCOUNT), "OUTLAYER_WALLET_ACCOUNT", "the OutLayer wallet's NEAR account, which the DAO tops up");
  }
  return out;
}

/**
 * Identity verification (KYB) through Persona (withpersona.com), the platform's own account. Vendors and businesses are sent a hosted
 * verification link; Persona's decision (approved or declined) comes back by webhook and is confirmed with a call to Persona's API.
 *  - PERSONA_API_KEY and the templates: from the Persona dashboard (sandbox is free).
 *  - PERSONA_WEBHOOK_SECRET: signs the webhooks (wbhsec_...).
 *  - KYB_REQUIRED=1: a signed-up business cannot release payments until its own verification is approved.
 */
export const PERSONA_API_KEY = process.env.PERSONA_API_KEY ?? "";
export const PERSONA_BASE = (process.env.PERSONA_BASE_URL ?? "https://api.withpersona.com").replace(/\/$/, "");
export const PERSONA_VERSION = process.env.PERSONA_VERSION ?? "2025-12-08";
export const PERSONA_WEBHOOK_SECRET = process.env.PERSONA_WEBHOOK_SECRET ?? "";
export const PERSONA_TEMPLATE_VENDOR = process.env.PERSONA_TEMPLATE_VENDOR ?? "";
export const PERSONA_TEMPLATE_BUSINESS = process.env.PERSONA_TEMPLATE_BUSINESS ?? "";
export const KYB_ENABLED = !!PERSONA_API_KEY && !!(PERSONA_TEMPLATE_VENDOR || PERSONA_TEMPLATE_BUSINESS);
export const KYB_REQUIRED = process.env.KYB_REQUIRED === "1";
/**
 * Short retention: days after Persona's final decision before the app asks Persona to delete the documents (DELETE /inquiries/{id}),
 * leaving only the decision here. Default 7, so an attester can still re-check the decision for a credential. "off" never deletes.
 */
export const PERSONA_REDACT_AFTER_DAYS: number | null =
  process.env.PERSONA_REDACT_AFTER_DAYS === "off" ? null : Math.max(0, Number(process.env.PERSONA_REDACT_AFTER_DAYS ?? 7) || 0);

/**
 * Passport proofs through Self (self.xyz, lib/passport.ts), with Self's enterprise API (its open SDK is deprecated). The person opens a
 * hosted link, the Self app reads their passport chip and makes a zero-knowledge proof; Self tells us by signed webhook and the app
 * re-verifies the proof itself. What the proof checks is the "flow" you build in Self's dashboard: set it to OFAC screening and a minimum
 * age, and disclose nothing else, so no name, number or document reaches anyone.
 *  - SELF_API_KEY (sk_...), SELF_FLOW_ID, SELF_WEBHOOK_SECRET (whsec_...) and SELF_ORG_ID (for re-verifying proofs) turn it on.
 *  - Point the flow's webhook at PUBLIC_BASE_URL/api/passport/webhook.
 *  - SELF_ALLOW_TEST=1 also accepts Self's test environment (mock documents), for trying it without a real passport.
 */
export const SELF_API_KEY = process.env.SELF_API_KEY ?? "";
export const SELF_FLOW_ID = process.env.SELF_FLOW_ID ?? "";
export const SELF_WEBHOOK_SECRET = process.env.SELF_WEBHOOK_SECRET ?? "";
export const SELF_ORG_ID = process.env.SELF_ORG_ID ?? "";
export const SELF_BASE_URL = process.env.SELF_BASE_URL || undefined;
export const SELF_ALLOW_TEST = process.env.SELF_ALLOW_TEST === "1";
export const PASSPORT_ENABLED = !!(SELF_API_KEY && SELF_FLOW_ID && SELF_WEBHOOK_SECRET && SELF_ORG_ID);
