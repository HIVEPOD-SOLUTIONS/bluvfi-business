// The master key read from a secrets file, for tests/keys.test.ts. Imported after ./setup and before any lib module.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const KEY_DIR = mkdtempSync(join(tmpdir(), "bluvfi-keys-"));
export const FILE_MASTER_KEY = "cd".repeat(32);
const file = join(KEY_DIR, "master-key");
writeFileSync(file, `${FILE_MASTER_KEY}\n`);
process.env.BLUVFI_MASTER_KEY_FILE = file;
