// The agent's x402 spending against the REAL x402.org test API and facilitator on Base Sepolia, with nothing faked. Test USDC is free, so
// nothing real can be spent. The payer's wallet is the one `npm run x402:payer -- setup` made if it exists (so a funded wallet is
// used), and a throwaway otherwise, which the real API simply finds has no balance.
import { existsSync, readFileSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import "./setup";

export const PAYER_PORT = 47840;
export const PAYER_TOKEN = "real-test-token-0123456789";
export const PAYER_KEY: `0x${string}` = existsSync(".testnet/x402-payer.json")
  ? (JSON.parse(readFileSync(".testnet/x402-payer.json", "utf8")) as { privateKey: `0x${string}` }).privateKey
  : generatePrivateKey();

process.env.X402_TESTNET = "1";
process.env.X402_PAYER_URL = `http://127.0.0.1:${PAYER_PORT}`;
process.env.X402_PAYER_TOKEN = PAYER_TOKEN;
