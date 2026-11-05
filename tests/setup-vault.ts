// Records are written to real files in a temporary folder, so what lands on disk can be read back and inspected. Imported first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup";

export const DIR = mkdtempSync(join(tmpdir(), "bluvfi-vault-"));
process.env.BLUVFI_PERSIST = "1";
process.env.BLUVFI_DATA_FILE = join(DIR, "state.json");
process.env.BLUVFI_BUSINESSES_FILE = join(DIR, "businesses.json");
