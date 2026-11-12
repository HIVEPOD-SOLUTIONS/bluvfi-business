import { configuredCardProvider, type CardProvider } from "./card-providers";
import { confidentialPayoutStatus, quoteConfidentialPayout } from "./confidential-flow";
import { lookupSignals, spendingWalletBalances, treasuryBalances } from "./chain";
import { DEMO_AI_MODEL, NEAR_AI_MODEL } from "./config";
import { refreshPayout, submitPayout } from "./custody";
import { demoServices } from "./demo";
import { judgeWithNearAi } from "./nearai";
import { buildRequest, type JudgeFacts } from "./nearai-core";
import { payX402, quoteForWidget, quotePayout, quoteReceivable, sendCallback, submitDeposit, swapStatus } from "./rails";
import { redact } from "./redact";
import { screenSanctions } from "./sanctions";
import { isDemo } from "./tenant";

/**
 * Every outside service the app talks to, in one object. The defaults are the real mainnet
 * services. Demo mode (BLUVFI_DEMO=1) swaps in the fixtures from lib/demo.ts; tests replace members
 * with fakes. Nothing else changes them.
 */
const live = {
  redact,
  judge: (redactedText: string, facts: JudgeFacts) => judgeWithNearAi(buildRequest(NEAR_AI_MODEL, redactedText, facts)),
  quotePayout,
  quoteConfidential: quoteConfidentialPayout,
  confidentialStatus: confidentialPayoutStatus,
  quoteReceivable,
  quoteForWidget,
  swapStatus,
  submitDeposit,
  sendCallback,
  lookupSignals,
  screenSanctions,
  treasuryBalances,
  spendingWalletBalances,
  payX402,
  submitPayout,
  refreshPayout,
  /** The card issuer the agent gets one-time cards from (lib/cards.ts), or null when none is set up. */
  // Called lazily: card-providers reads the business settings, and they import this file in turn.
  cardProvider: (): CardProvider | null => configuredCardProvider(),
};

/**
 * What a piece of work calls is chosen by its business's mode: a business in demo gets the fixtures, a live one the real services (or what a test
 * put in their place). The demo fixtures are made on first use and shared, so a simulated DAO is the same one for every business in demo.
 */
let demo: Partial<typeof live> | undefined;
/** Services a script replaced for demo mode too (`overrideService`). */
const forced = new Set<string>();
export const services: typeof live = new Proxy(live, {
  get(target, key: string) {
    if (isDemo() && !forced.has(key)) {
      demo ??= demoServices(DEMO_AI_MODEL) as Partial<typeof live>;
      if (key in demo) return demo[key as keyof typeof live];
    }
    return target[key as keyof typeof live];
  },
});

/** Scripts only (npm run fixtures): replace one service everywhere, demo mode included. */
export function overrideService<K extends keyof typeof live>(key: K, fn: (typeof live)[K]) {
  live[key] = fn;
  forced.add(key);
}
