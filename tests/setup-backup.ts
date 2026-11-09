// Backups go to a second folder, and to a local stand-in for an S3 bucket (tests/backup.test.ts). Imported before lib/backup.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup-vault";

export const OUT = mkdtempSync(join(tmpdir(), "bluvfi-backups-"));
export const S3_PORT = 47895;
process.env.BLUVFI_BACKUP_DIR = OUT;
process.env.BLUVFI_BACKUP_S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;
process.env.BLUVFI_BACKUP_S3_BUCKET = "bluvfi-test";
process.env.BLUVFI_BACKUP_S3_REGION = "auto";
process.env.BLUVFI_BACKUP_S3_ACCESS_KEY_ID = "TESTKEYID";
process.env.BLUVFI_BACKUP_S3_SECRET_ACCESS_KEY = "test-secret-key";
