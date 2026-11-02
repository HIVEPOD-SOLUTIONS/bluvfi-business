// Real-chain tests: imported FIRST by every file in tests/testnet. Reads the throwaway testnet treasury that
// `npm run testnet:keys && npm run testnet:setup` built, and points the app at it. Nothing here is mocked.
import { existsSync, readFileSync } from "node:fs";

if (!existsSync(".testnet/accounts.json")) throw new Error("No testnet treasury yet. Run: npm run testnet:keys && npm run testnet:setup");
const acc = JSON.parse(readFileSync(".testnet/accounts.json", "utf8")) as { dao: string; accounts: Record<string, string> };
export const keys = JSON.parse(readFileSync(".testnet/keys.json", "utf8")) as Record<string, { account: string; secret: string; publicKey: string }>;

process.env.BLUVFI_NETWORK = "testnet";
process.env.BLUVFI_PERSIST = "0";
process.env.BLUVFI_MASTER_KEY = "ab".repeat(32);
process.env.BLUVFI_SIGNERS = "maya:maya-token-0123456789,devon:devon-token-0123456789";
process.env.CUSTODY = "sputnik";
process.env.DAO_ACCOUNT = acc.dao;
process.env.AGENT_ACCOUNT = acc.accounts.agent;
process.env.AGENT_PRIVATE_KEY = keys.agentScoped.secret;
process.env.RELAYER_ACCOUNT = acc.accounts.relayer;
process.env.RELAYER_PRIVATE_KEY = keys.relayer.secret;
delete process.env.BLUVFI_DEMO;

export const DAO = acc.dao;
export const ACCOUNTS = acc.accounts;
