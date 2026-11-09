// A signed-up business backs up its own records to its own bucket (tests/business-backup.test.ts): records on real files in a
// temporary folder, Privy sign-in for business owners, and a local stand-in for the business's S3 bucket.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup-privy";

export const DIR = mkdtempSync(join(tmpdir(), "bluvfi-bizbackup-"));
export const BUCKET_PORT = 47896;
process.env.BLUVFI_PERSIST = "1";
process.env.BLUVFI_DATA_FILE = join(DIR, "state.json");
process.env.BLUVFI_BUSINESSES_FILE = join(DIR, "businesses.json");
process.env.BLUVFI_MODES_FILE = join(DIR, "modes.json");
// The bucket is on this machine in tests; in the app, a bucket on a private address is refused.
process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS = "1";
