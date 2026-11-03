// Treasury setup, for tests/setup-flow.test.ts. Imported after ./setup and before any lib module: setup keeps its keys
// and plan in a folder and writes an env file, and both go to a throwaway directory instead of .mainnet and .env.local.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const SETUP_DIR = mkdtempSync(join(tmpdir(), "bluvfi-setup-"));
process.env.BLUVFI_SETUP_DIR = SETUP_DIR;
process.env.BLUVFI_ENV_FILE = join(SETUP_DIR, ".env.local");
