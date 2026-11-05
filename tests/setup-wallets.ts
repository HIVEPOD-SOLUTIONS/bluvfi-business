// The platform's wallets, for tests/wallets.test.ts. Imported after ./setup and before any lib module: key files go to a
// throwaway folder, never to the project's .mainnet or .testnet.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const WALLETS_ROOT = mkdtempSync(join(tmpdir(), "bluvfi-wallets-"));
process.env.BLUVFI_WALLETS_ROOT = WALLETS_ROOT;
