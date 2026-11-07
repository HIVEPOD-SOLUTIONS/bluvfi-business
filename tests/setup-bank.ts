// Credible Finance: a local server that speaks its on-ramp and off-ramp APIs stands in for it. Imported first.
import "./setup";

export const BANK_PORT = 47891;
process.env.CREDIBLE_BASE = `http://127.0.0.1:${BANK_PORT}`;
process.env.CREDIBLE_FINANCE_API_KEY = "test-credible-key";
process.env.CREDIBLE_FINANCE_API_SECRET = "test-credible-secret";
