// Imported first by every test file: configuration is read when lib/config loads.
process.env.PROOFPAY_PERSIST = "0";
process.env.PROOFPAY_MASTER_KEY = "ab".repeat(32);
process.env.PROOFPAY_SIGNERS = "maya:maya-token-0123456789,devon:devon-token-0123456789";
process.env.TREASURY_ACCOUNT = "treasury.near";
process.env.NEAR_AI_API_KEY = "test-key";
process.env.TWILIO_AUTH_TOKEN = "twilio-test-token";
process.env.PUBLIC_BASE_URL = "https://proofpay.example";
process.env.X402_FACILITATOR_URL = "https://facilitator.example";
process.env.AGENT_MARKET_TOKEN = "aat_test";
process.env.AGENT_MARKET_CRON_SECRET = "cron-secret-test";
