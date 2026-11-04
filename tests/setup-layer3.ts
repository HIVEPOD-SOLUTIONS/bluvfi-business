// Layer 3 rails tests: the shared test setup, plus the platform's scheduler secret.
import "./setup";

export const CRON = "settlement-cron-secret-0123456789";
process.env.SETTLEMENT_CRON_SECRET = CRON;
