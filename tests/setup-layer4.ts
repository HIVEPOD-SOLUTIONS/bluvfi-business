// Layer 4 unit tests: the x402.org test facilitator is configured (no PingPay key, no generic facilitator). Imported first.
import "./setup";

delete process.env.X402_FACILITATOR_URL;
process.env.X402_TESTNET = "1";
process.env.X402_PAYTO_EVM = "0x1111111111111111111111111111111111111111";
process.env.X402_PAYER_URL = "http://127.0.0.1:47851/payer";
