import { lookupSignals, treasuryBalances } from "./chain";
import { NEAR_AI_MODEL } from "./config";
import { judgeWithNearAi } from "./nearai";
import { buildRequest, type JudgeFacts } from "./nearai-core";
import { payX402, quotePayout, quoteReceivable, sendCallback, swapStatus } from "./rails";
import { redact } from "./redact";

/**
 * Every outside service the app talks to, in one object. The defaults are the real mainnet
 * services. Tests replace members of this object with fakes; nothing else does.
 */
export const services = {
  redact,
  judge: (redactedText: string, facts: JudgeFacts) => judgeWithNearAi(buildRequest(NEAR_AI_MODEL, redactedText, facts)),
  quotePayout,
  quoteReceivable,
  swapStatus,
  sendCallback,
  lookupSignals,
  treasuryBalances,
  payX402,
};
