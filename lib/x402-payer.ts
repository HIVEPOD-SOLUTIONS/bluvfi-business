import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHAINS, signExactEvm, type ExactEvmRequirements } from "./x402-signer";

/**
 * The payer: the one place a payment key lives. The app never holds it; it asks this service to pay an API, and the service decides
 * whether to. It is a separate process on purpose, holding a small wallet that is topped up by hand, so the worst a bug or a bad API
 * can cost is what is in that wallet. Its own rules, which the app cannot change:
 *  - only the shared secret opens it;
 *  - only USDC on Base, and only the network its mode allows (testnet by default, so a mistake spends nothing real);
 *  - no payment above a per-payment cap, and no more than a daily cap in total.
 */
export interface PayerConfig {
  privateKey: `0x${string}`;
  /** True: signs only for Base Sepolia (free test USDC). False: only for Base mainnet. */
  testnet: boolean;
  maxPaymentUsd: number;
  maxDayUsd: number;
  /** The shared secret the app sends as a bearer token. */
  token: string;
  /** Where the day's spending is kept, so a restart does not reset the cap. */
  spentFile?: string;
  now?: () => number;
}

export interface PayRequest {
  url?: string;
  requirements?: ExactEvmRequirements;
  resource?: unknown;
}

export interface PayResult { status: number; body: { paymentHeader?: string; from?: string; usd?: number; error?: string } }

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createPayer(cfg: PayerConfig) {
  if (!cfg.token) throw new Error("The payer needs a shared secret (token)");
  const now = cfg.now ?? (() => Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);
  let day = today();
  let spent = 0;
  if (cfg.spentFile && existsSync(cfg.spentFile)) {
    try {
      const s = JSON.parse(readFileSync(cfg.spentFile, "utf8")) as { day: string; usd: number };
      if (s.day === day) spent = s.usd;
    } catch {
      /* an unreadable file counts as a fresh day, not as a way around the cap: it is rewritten with the next payment */
    }
  }
  const remember = () => {
    if (!cfg.spentFile) return;
    mkdirSync(dirname(cfg.spentFile), { recursive: true });
    writeFileSync(cfg.spentFile, JSON.stringify({ day, usd: spent }));
  };

  async function pay(req: PayRequest, authorization: string | undefined): Promise<PayResult> {
    const refuse = (status: number, error: string): PayResult => ({ status, body: { error } });
    if (!authorization || !same(authorization, `Bearer ${cfg.token}`)) return refuse(401, "Not authorised");
    const r = req.requirements;
    if (!r) return refuse(400, "No payment requirements were given");
    const chain = CHAINS[r.network];
    if (!chain) return refuse(403, `This payer does not sign for ${r.network}`);
    if (chain.testnet !== cfg.testnet) return refuse(403, `This payer is in ${cfg.testnet ? "testnet" : "mainnet"} mode and will not sign for ${r.network}`);
    const raw = r.amount ?? r.maxAmountRequired;
    const usd = Number(raw) / 1e6;
    if (!raw || !/^\d+$/.test(raw) || !(usd > 0)) return refuse(400, "The price could not be read");
    if (usd > cfg.maxPaymentUsd) return refuse(403, `$${usd} is over this payer's $${cfg.maxPaymentUsd} limit for one payment`);
    if (today() !== day) { day = today(); spent = 0; }
    if (spent + usd > cfg.maxDayUsd) return refuse(403, `Paying $${usd} would take today's spending past this payer's $${cfg.maxDayUsd} daily limit ($${spent} already)`);
    try {
      const signed = await signExactEvm(r, cfg.privateKey, { resource: req.resource, nowSec: Math.floor(now() / 1000) });
      spent += usd; // counted when signed: a signature can be spent at any moment in its window
      remember();
      return { status: 200, body: { paymentHeader: signed.paymentHeader, from: signed.from, usd } };
    } catch (e) {
      return refuse(400, (e as Error).message);
    }
  }

  return { pay, spentToday: () => (today() === day ? spent : 0) };
}
