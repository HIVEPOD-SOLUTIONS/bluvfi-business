// OutLayer on its real TESTNET API (testnet-api.outlayer.ai), with the wallet registered by `POST /register`
// (details in .testnet/outlayer.json, git-ignored). Imported first by tests/testnet/outlayer.test.ts. Nothing is mocked.
import { existsSync, readFileSync } from "node:fs";

if (!existsSync(".testnet/outlayer.json")) throw new Error("No OutLayer testnet wallet. Register one: POST https://testnet-api.outlayer.ai/register, and save the result in .testnet/outlayer.json");
export const outlayer = JSON.parse(readFileSync(".testnet/outlayer.json", "utf8")) as { baseUrl: string; apiKey: string; walletId: string; nearAccountId: string; handoffUrl: string };

process.env.BLUVFI_NETWORK = "testnet";
process.env.BLUVFI_PERSIST = "0";
process.env.BLUVFI_MASTER_KEY = "ab".repeat(32);
process.env.BLUVFI_SIGNERS = "maya:maya-token-0123456789,devon:devon-token-0123456789";
process.env.TREASURY_ACCOUNT = outlayer.nearAccountId;
process.env.CUSTODY = "outlayer";
process.env.OUTLAYER_API_KEY = outlayer.apiKey;
process.env.OUTLAYER_BASE_URL = outlayer.baseUrl;
for (const k of ["DAO_ACCOUNT", "AGENT_ACCOUNT", "AGENT_PRIVATE_KEY", "BLUVFI_DEMO"]) delete process.env[k];
