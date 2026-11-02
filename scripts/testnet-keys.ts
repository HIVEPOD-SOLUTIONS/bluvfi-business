/**
 * Generates throwaway TESTNET identities for the real-chain test suite and writes them to .testnet/keys.json
 * (git-ignored). Implicit accounts (the 64-hex public key) need no registrar: they exist once the faucet funds them.
 *   npm run testnet:keys
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";

const FILE = ".testnet/keys.json";
const ROLES = ["council1", "council2", "council3", "agent", "relayer"] as const;
type Role = (typeof ROLES)[number];

const implicit = (k: KeyPair) => Buffer.from(k.getPublicKey().data).toString("hex");

const out: Record<string, { account: string; secret: string; publicKey: string }> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
for (const r of ROLES as readonly Role[]) {
  if (out[r]) continue;
  const k = KeyPair.fromRandom("ed25519");
  out[r] = { account: implicit(k), secret: k.toString(), publicKey: k.getPublicKey().toString() };
}
mkdirSync(".testnet", { recursive: true });
writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log("Testnet identities in", FILE, "(never commit this file)\n");
for (const r of ROLES) console.log(r.padEnd(9), out[r].account);
console.log("\nFund each account with testnet NEAR (faucet), then run: npm run testnet:setup");
