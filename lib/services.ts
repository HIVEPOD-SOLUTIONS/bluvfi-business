import { configuredCardProvider, type CardProvider } from "./card-providers";
import { confidentialPayoutStatus, quoteConfidentialPayout } from "./confidential-flow";
import { lookupSignals, spendingWalletBalances, treasuryBalances } from "./chain";
import { DEMO, NEAR_AI_MODEL } from "./config";
import { refreshPayout, submitPayout } from "./custody";
import { demoServices } from "./demo";
import { judgeWithNearAi } from "./nearai";
import { buildRequest, type JudgeFacts } from "./nearai-core";
import { payX402, quoteForWidget, quotePayout, quoteReceivable, sendCallback, submitDeposit, swapStatus } from "./rails";
import { redact } from "./redact";
import { screenSanctions } from "./sanctions";

/**
 * Every outside service the app talks to, in one object. The defaults are the real mainnet
 * services. Demo mode (BLUVFI_DEMO=1) swaps in the fixtures from lib/demo.ts; tests replace members
 * with fakes. Nothing else changes them.
 */
export const services = {
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

if (DEMO) Object.assign(services, demoServices(NEAR_AI_MODEL));
