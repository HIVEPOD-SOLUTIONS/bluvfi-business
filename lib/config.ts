/**
 * Mainnet by default: every service below is the real one, and anything that is not configured makes the
 * affected feature refuse to run (see `missingConfig`).
 *
 * BLUVFI_DEMO=1 (`npm run demo`) swaps the outside services for recorded fixtures (lib/demo.ts) and fills in
 * throwaway keys, so the whole flow runs with no keys and no funds. Verification still runs on the fixtures.
 */
export const DEMO = process.env.BLUVFI_DEMO === "1";
export const NETWORK = "mainnet" as const;

/** Throwaway values for demo mode only; never used when BLUVFI_DEMO is off. */
const DEMO_DEFAULTS = {
  BLUVFI_MASTER_KEY: "de".repeat(32),
  BLUVFI_SIGNERS: "maya:demo-signer-maya-token,devon:demo-signer-devon-token",
  TREASURY_ACCOUNT: "bluvfi-demo.near",
};
const env = (key: keyof typeof DEMO_DEFAULTS) => process.env[key] ?? (DEMO ? DEMO_DEFAULTS[key] : "");

export const NEAR_AI_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE = process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1";
export const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL ?? "zai-org/GLM-5.1-FP8";

export const NEAR_RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org";
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
export const AGENT_MARKET_CRON_SECRET = process.env.AGENT_MARKET_CRON_SECRET ?? "";

/** PingPay Agent Pay facilitator for selling Check over x402 (buyers pay USDC on Base, we receive USDC on NEAR). */
export const PINGPAY_API_KEY = process.env.PINGPAY_API_KEY ?? "";
export const PINGPAY_BASE = (process.env.PINGPAY_BASE_URL ?? "https://pay.pingpay.io").replace(/\/$/, "");
export const X402_FACILITATOR_URL = (process.env.X402_FACILITATOR_URL ?? "").replace(/\/$/, "");
/** A service that signs an x402 payment for the agent, so this app never holds a payment key. */
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
/** `ed25519:…` (or `mldsa65:…`, post-quantum) secret of the agent's function-call key. */
export const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY ?? "";
/** Pays gas for council votes sent as NEP-366 meta transactions (only `act_proposal` on DAO_ACCOUNT). */
export const RELAYER_ACCOUNT = process.env.RELAYER_ACCOUNT ?? "";
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? "";
export const TREZU_APP_URL = (process.env.TREZU_APP_URL ?? "https://trezu.app").replace(/\/$/, "");
export const OUTLAYER_BASE = (process.env.OUTLAYER_BASE_URL ?? "https://api.outlayer.ai").replace(/\/$/, "");
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
/** With Sputnik custody, policy changes are approved by the DAO council (a Vote proposal), not by app signers. POLICY_VIA_DAO=0 opts out. */
/** REQUIRE_CUSTODIAN_LIMITS=1: with OutLayer custody, refuse payouts while the custodian lacks a limit, or has a looser one, than this app's policy. */
export const REQUIRE_CUSTODIAN_LIMITS = process.env.REQUIRE_CUSTODIAN_LIMITS === "1";
export const POLICY_VIA_DAO = DAO_CUSTODY && !DEMO && process.env.POLICY_VIA_DAO !== "0";

/** NEAR mainnet account that receives money and is the 1Click refund address. With a DAO, the DAO itself. */
export const TREASURY_ACCOUNT = env("TREASURY_ACCOUNT") || (DAO_CUSTODY ? DAO_ACCOUNT : "");
export const MASTER_KEY = env("BLUVFI_MASTER_KEY");

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

/** What must be set before the app can do its job. Shown on Overview; features refuse to run without it. */
export function missingConfig(): { key: string; why: string }[] {
  const out: { key: string; why: string }[] = [];
  const need = (ok: boolean, key: string, why: string) => ok || out.push({ key, why });
  need(/^[0-9a-f]{64}$/i.test(MASTER_KEY), "BLUVFI_MASTER_KEY", "64 hex characters; derives the record encryption and signing keys");
  need(SIGNERS.length > 0, "BLUVFI_SIGNERS", "name:token pairs (token 16+ characters) for the people who can approve");
  need(/\.near$|^[0-9a-f]{64}$/.test(TREASURY_ACCOUNT), "TREASURY_ACCOUNT", "your NEAR mainnet account (name.near or a 64-hex implicit account)");
  need(!!NEAR_AI_KEY || DEMO, "NEAR_AI_API_KEY", "private AI review; without it every payment is held for a human");
  if (DAO_CUSTODY && !DEMO) {
    need(/\.near$/.test(DAO_ACCOUNT), "DAO_ACCOUNT", "your Sputnik DAO / Trezu treasury, e.g. acme.sputnik-dao.near");
    need(!!AGENT_ACCOUNT, "AGENT_ACCOUNT", "the NEAR account the agent proposes from");
    need(/^(ed25519|mldsa65):/.test(AGENT_PRIVATE_KEY), "AGENT_PRIVATE_KEY", "the agent's function-call key, scoped to add_proposal on the DAO");
  }
  if (CUSTODY === "hybrid" && !DEMO) {
    need(!!OUTLAYER_API_KEY, "OUTLAYER_API_KEY", "the agent's API key for the OutLayer spending wallet");
    need(/[.]near$|^[0-9a-f]{64}$/.test(OUTLAYER_WALLET_ACCOUNT), "OUTLAYER_WALLET_ACCOUNT", "the OutLayer wallet's NEAR account, which the DAO tops up");
  }
  return out;
}
