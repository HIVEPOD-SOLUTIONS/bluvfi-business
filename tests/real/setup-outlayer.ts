// OutLayer's real MAINNET API, read-only, with an empty wallet registered by `POST /register` (details in
// .testnet/outlayer-mainnet.json, git-ignored). OutLayer's dashboard only opens mainnet wallets, which is the only way to
// set a policy, so the policy tests live here. The tests never fund the wallet and never send anything: they read its policy.
import { existsSync, readFileSync } from "node:fs";

if (!existsSync(".testnet/outlayer-mainnet.json")) throw new Error("No OutLayer mainnet wallet. Register one: POST https://api.outlayer.ai/register, and save the result in .testnet/outlayer-mainnet.json");
export const outlayer = JSON.parse(readFileSync(".testnet/outlayer-mainnet.json", "utf8")) as { baseUrl: string; apiKey: string; walletId: string; nearAccountId: string; handoffUrl: string };

process.env.BLUVFI_PERSIST = "0";
process.env.BLUVFI_MASTER_KEY = "ab".repeat(32);
process.env.BLUVFI_SIGNERS = "maya:maya-token-0123456789,devon:devon-token-0123456789";
process.env.TREASURY_ACCOUNT = "near";
process.env.CUSTODY = "outlayer";
process.env.OUTLAYER_API_KEY = outlayer.apiKey;
process.env.OUTLAYER_BASE_URL = outlayer.baseUrl;
for (const k of ["DAO_ACCOUNT", "AGENT_ACCOUNT", "AGENT_PRIVATE_KEY", "BLUVFI_DEMO", "BLUVFI_NETWORK"]) delete process.env[k];
