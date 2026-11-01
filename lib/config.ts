/**
 * Mainnet only. There is no demo mode: every service below is the real one, and anything that is
 * not configured makes the affected feature refuse to run (see `missingConfig`).
 */
export const NETWORK = "mainnet" as const;

export const NEAR_AI_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE = process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1";
export const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL ?? "zai-org/GLM-5.1-FP8";

export const NEAR_RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org";
export const EVM_RPC_URL = process.env.EVM_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

export const ONECLICK_BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
export const ONECLICK_JWT = process.env.ONECLICK_JWT ?? "";

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

export const X402_FACILITATOR_URL = (process.env.X402_FACILITATOR_URL ?? "").replace(/\/$/, "");
/** A service that signs an x402 payment for the agent, so this app never holds a payment key. */
export const X402_PAYER_URL = (process.env.X402_PAYER_URL ?? "").replace(/\/$/, "");

/** NEAR mainnet account that receives money and is the 1Click refund address. */
export const TREASURY_ACCOUNT = process.env.TREASURY_ACCOUNT ?? "";
export const MASTER_KEY = process.env.PROOFPAY_MASTER_KEY ?? "";

/** `PROOFPAY_SIGNERS="maya:token1,devon:token2"`: who may approve, and the secret each signs in with. */
export const SIGNERS: { name: string; token: string }[] = (process.env.PROOFPAY_SIGNERS ?? "")
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
  need(/^[0-9a-f]{64}$/i.test(MASTER_KEY), "PROOFPAY_MASTER_KEY", "64 hex characters; derives the record encryption and signing keys");
  need(SIGNERS.length > 0, "PROOFPAY_SIGNERS", "name:token pairs (token 16+ characters) for the people who can approve");
  need(/\.near$|^[0-9a-f]{64}$/.test(TREASURY_ACCOUNT), "TREASURY_ACCOUNT", "your NEAR mainnet account (name.near or a 64-hex implicit account)");
  need(!!NEAR_AI_KEY, "NEAR_AI_API_KEY", "private AI review; without it every payment is held for a human");
  return out;
}
