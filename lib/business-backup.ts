import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { backupName, backupTime, DATA_DIR, prune, s3Destination, type Destination } from "./backup";
import { businesses, getBusiness, saveRegistry, type Business, type BusinessBackupConfig } from "./business";
import { decrypt, encrypt } from "./crypto";
import { assertPublicUrl, publicFetch } from "./net-guard";
import { exclusive } from "./shared-file";
import { dataKey, recordsOf, replaceRecords, type State } from "./store";
import { DEFAULT_BIZ } from "./tenant";

/**
 * Each business's own backups (Settings page), separate from the platform's backup (lib/backup.ts):
 *  - an owner connects the business's own S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2...) and chooses a passphrase;
 *  - every day the app sends one file with that business's records (live and demo) and its profile (name, team, verification), and
 *    nothing of any other business, encrypted under the passphrase (scrypt, then AES-256-GCM). Stored keys are left out;
 *  - so the business can open its own backup without this platform: `npm run backup -- open <file>` with the passphrase;
 *  - an owner can restore from Settings; the records that were there are kept beside them, never deleted.
 * The bucket's address is checked to be a public host, so a business cannot point the server at an internal one.
 */

const FORMAT = "bluvfi-business-backup-v1";
const EVERY_HOURS = Number(process.env.BLUVFI_BACKUP_EVERY_HOURS || 24);
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---------- Settings ----------

export interface BackupSettingsInput { endpoint?: string; bucket?: string; region?: string; prefix?: string; accessKeyId?: string; secretAccessKey?: string; passphrase?: string }

/** The bucket must be on the public internet: never this server, its network, or a cloud metadata address. */
export async function assertPublicEndpoint(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The bucket's endpoint must be a URL such as https://<account>.r2.cloudflarestorage.com");
  }
  if (url.protocol !== "https:" && process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS !== "1") throw new Error("The bucket's endpoint must start with https://");
  if (process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS === "1") return; // tests, against a local stand-in
  await assertPublicUrl(endpoint, "The bucket's endpoint");
}

/** What the Settings page may show: never the secret key or the passphrase. */
export function backupSettingsView(id: string) {
  const b = getBusiness(id)?.backup;
  return b
    ? { on: true, endpoint: b.endpoint, bucket: b.bucket, region: b.region, prefix: b.prefix, accessKeyId: b.accessKeyId, status: b.status ?? {} }
    : { on: false, endpoint: "", bucket: "", region: "", prefix: "", accessKeyId: "", status: {} };
}

/** Save the business's bucket and passphrase. A field left empty keeps what was there; a new business must give them all. */
export async function setBackupSettings(id: string, input: BackupSettingsInput): Promise<void> {
  if (id === DEFAULT_BIZ) throw new Error("The operator's business is covered by the platform backup (BLUVFI_BACKUP_* in .env.local)");
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  const was = b.backup;
  const t = (v?: string) => (v ?? "").trim();
  const endpoint = (t(input.endpoint) || was?.endpoint || "").replace(/\/+$/, "");
  const bucket = t(input.bucket) || was?.bucket || "";
  const region = t(input.region) || was?.region || "auto";
  const prefix = t(input.prefix) || was?.prefix || "bluvfi/";
  const accessKeyId = t(input.accessKeyId) || was?.accessKeyId || "";
  const secret = t(input.secretAccessKey);
  const passphrase = input.passphrase ?? "";
  if (!endpoint || !bucket || !accessKeyId || (!secret && !was) || (!passphrase && !was)) throw new Error("Give the endpoint, bucket, access key id, secret key and a passphrase");
  await assertPublicEndpoint(endpoint);
  // The registry may have been re-read while the address was checked: change the business as it is now.
  const live = getBusiness(id);
  if (!live) throw new Error("Unknown business");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("That is not a bucket name (3 to 63 lowercase letters, digits, dots and dashes)");
  if (!/^[a-z0-9-]{2,30}$/.test(region)) throw new Error("The region is a short name such as us-east-1, or auto for Cloudflare R2");
  if (!/^[A-Za-z0-9._/-]{0,100}$/.test(prefix) || prefix.split("/").includes("..")) throw new Error("The folder in the bucket may use letters, digits, dots, dashes and slashes");
  if (!/^[A-Za-z0-9+/=_.-]{8,128}$/.test(accessKeyId)) throw new Error("That is not an access key id");
  if (secret && (secret.length < 8 || secret.length > 256)) throw new Error("That is not a secret key");
  if (passphrase && (passphrase.length < 12 || passphrase.length > 200)) throw new Error("The passphrase needs at least 12 characters");
  const key = dataKey();
  live.backup = {
    endpoint, bucket, region, prefix: prefix.endsWith("/") || !prefix ? prefix : `${prefix}/`, accessKeyId,
    secretAccessKey: secret ? encrypt(secret, key) : was!.secretAccessKey,
    passphrase: passphrase ? encrypt(passphrase, key) : was!.passphrase,
    status: was?.status,
  };
  saveRegistry();
}

export function clearBackupSettings(id: string) {
  const b = getBusiness(id);
  if (!b) throw new Error("Unknown business");
  delete b.backup;
  saveRegistry();
}

/** The business's own folder in its bucket: one per business, so two businesses sharing a bucket never touch each other's files. */
function destination(id: string, c: BusinessBackupConfig): Destination {
  return s3Destination({ endpoint: c.endpoint, bucket: c.bucket, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: decrypt(c.secretAccessKey, dataKey()), prefix: `${c.prefix}${id}/` }, (url, init) => publicFetch(url, { ...init, allowPrivate: process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS === "1" }));
}

// ---------- The backup file ----------

export interface BusinessBundle {
  format: typeof FORMAT;
  createdAt: string;
  business: Pick<Business, "id" | "name" | "createdAt" | "team" | "kyb" | "passport">;
  records: { live: State | null; demo: State | null };
}

function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, SCRYPT);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.from(`${FORMAT}\n${salt.toString("hex")}\n${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}\n`);
}

/** Open a business backup with its passphrase. Needs nothing from this platform: not its master key, not its records. */
export function openBusinessBackup(body: Buffer, passphrase: string): BusinessBundle {
  const [format, saltHex, sealed] = body.toString("utf8").trim().split("\n");
  if (format !== FORMAT || !sealed) throw new Error("This is not a Bluvfi Business backup of one business (or it is cut short)");
  const raw = Buffer.from(sealed, "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32, SCRYPT), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(gunzipSync(Buffer.concat([d.update(raw.subarray(28)), d.final()]), { maxOutputLength: 512 * 1024 * 1024 }).toString("utf8")) as BusinessBundle;
  } catch {
    throw new Error("This backup does not open with that passphrase (or it is damaged)");
  }
}

export function makeBusinessBackup(id: string, now = new Date()): { name: string; body: Buffer } {
  const b = getBusiness(id);
  if (!b?.backup) throw new Error("This business has no backup bucket set up");
  const bundle: BusinessBundle = {
    format: FORMAT,
    createdAt: now.toISOString(),
    // The profile without stored keys: treasury and channel secrets stay on this platform, encrypted.
    business: { id: b.id, name: b.name, createdAt: b.createdAt, team: b.team, kyb: b.kyb, passport: b.passport },
    records: { live: recordsOf(id, false), demo: recordsOf(id, true) },
  };
  return { name: backupName(now), body: seal(gzipSync(JSON.stringify(bundle)), decrypt(b.backup.passphrase, dataKey())) };
}

// ---------- Running ----------

function setStatus(id: string, status: NonNullable<BusinessBackupConfig["status"]>) {
  const b = getBusiness(id);
  if (!b?.backup) return;
  b.backup.status = status;
  saveRegistry();
}

/** Back up one business now: upload, read back and open with the passphrase, then delete old ones. */
export async function runBusinessBackup(id: string, now = new Date(), opts: { onlyIfDue?: boolean } = {}) {
  // Locked across instances too, so two instances never back up the same business at once.
  return exclusive(`business-backup:${id}`, join(DATA_DIR, `business-backup-${id}`), async () => {
    const b = getBusiness(id);
    if (!b?.backup) throw new Error("This business has no backup bucket set up");
    const prev = b.backup.status ?? {};
    // Decided inside the lock: another instance may have just made today's backup.
    if (opts.onlyIfDue && prev.lastOkAt && now.getTime() - Date.parse(prev.lastOkAt) < EVERY_HOURS * 3_600_000) return prev;
    try {
      await assertPublicEndpoint(b.backup.endpoint);
      const d = destination(id, b.backup);
      const { name, body } = makeBusinessBackup(id, now);
      await d.put(name, body);
      openBusinessBackup(await d.get(name), decrypt(b.backup.passphrase, dataKey()));
      const deleted = await prune(d, now.getTime());
      const status = { lastAttemptAt: now.toISOString(), lastOkAt: now.toISOString(), lastName: name, lastBytes: body.length };
      setStatus(id, status);
      return { ...status, deleted };
    } catch (e) {
      setStatus(id, { ...prev, lastAttemptAt: now.toISOString(), error: (e as Error).message });
      throw e;
    }
  });
}

/** The business's backups in its bucket, newest first. */
export async function listBusinessBackups(id: string): Promise<{ name: string; at: string }[]> {
  const b = getBusiness(id);
  if (!b?.backup) return [];
  await assertPublicEndpoint(b.backup.endpoint);
  return (await destination(id, b.backup).list())
    .map((name) => ({ name, at: new Date(backupTime(name)).toISOString() }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * What a restore may change. A backup is opened with the owner's own passphrase from the owner's own bucket, so one owner
 * could also hand-make one; and an old one would bring back payments that have since been paid. So a restore never takes:
 * the policy history (only approvals change policy), a payment older than the one there now (paid stays paid, an open
 * proposal stays tracked), or fewer reserved invoice numbers; and it turns the kill switch on until a signer has looked.
 */
function safeRestore(backup: State, now: State | null): State {
  if (!now) return { ...backup, killSwitch: true, killLog: [{ at: new Date().toISOString(), by: "restore", on: true }, ...(backup.killLog ?? [])] };
  const current = new Map(now.payments.map((p) => [p.id, p]));
  const fromBackup = backup.payments.filter((p) => !current.has(p.id));
  const vendors = backup.vendors.map((v) => {
    const mine = now.vendors.find((x) => x.name === v.name);
    return mine ? { ...v, paidInvoiceNumbers: [...new Set([...mine.paidInvoiceNumbers, ...v.paidInvoiceNumbers])], payout: mine.payout, verifiedContact: mine.verifiedContact, pendingChange: mine.pendingChange } : v;
  });
  for (const mine of now.vendors) if (!vendors.some((v) => v.name === mine.name)) vendors.push(mine);
  return {
    ...backup,
    policies: now.policies,
    proposals: now.proposals,
    payments: [...now.payments, ...fromBackup],
    sealed: { ...backup.sealed, ...now.sealed },
    vendors,
    blocklist: [...now.blocklist, ...backup.blocklist.filter((b) => !now.blocklist.some((x) => x.value === b.value))],
    payrollRuns: [...(now.payrollRuns ?? []), ...(backup.payrollRuns ?? []).filter((r) => !(now.payrollRuns ?? []).some((x) => x.id === r.id))],
    killSwitch: true,
    killLog: [{ at: new Date().toISOString(), by: "restore", on: true }, ...now.killLog],
  };
}

/** Put a backup's records back (live and demo, whichever it holds). Profile and settings are left as they are now. */
export async function restoreBusinessBackup(id: string, name: string, now = new Date()): Promise<{ createdAt: string; restored: string[]; kept: string[] }> {
  const b = getBusiness(id);
  if (!b?.backup) throw new Error("This business has no backup bucket set up");
  if (!/^bluvfi-backup-\d{8}T\d{9}Z\.enc$/.test(name)) throw new Error("That is not one of this business's backups");
  await assertPublicEndpoint(b.backup.endpoint);
  const bundle = openBusinessBackup(await destination(id, b.backup).get(name), decrypt(b.backup.passphrase, dataKey()));
  if (bundle.business.id !== id) throw new Error("That backup belongs to another business");
  const restored: string[] = [];
  const kept: string[] = [];
  for (const demo of [false, true]) {
    const s = demo ? bundle.records.demo : bundle.records.live;
    if (!s) continue;
    const k = await replaceRecords(id, demo, safeRestore(s, recordsOf(id, demo)), now);
    restored.push(demo ? "demo" : "live");
    if (k) kept.push(k);
  }
  return { createdAt: bundle.createdAt, restored, kept };
}

/** The scheduled pass: every business whose last good backup is older than BLUVFI_BACKUP_EVERY_HOURS. Never throws. */
export async function businessBackupsDue(now = new Date()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!(EVERY_HOURS > 0)) return out;
  for (const b of businesses()) {
    if (b.id === DEFAULT_BIZ || !b.backup) continue;
    const s = b.backup.status;
    if (s?.lastOkAt && now.getTime() - Date.parse(s.lastOkAt) < EVERY_HOURS * 3_600_000) continue;
    // After a failure, try again once an hour rather than on every tick.
    if (s?.error && s.lastAttemptAt && (!s.lastOkAt || s.lastAttemptAt > s.lastOkAt) && now.getTime() - Date.parse(s.lastAttemptAt) < 3_600_000) continue;
    try {
      out[b.id] = (await runBusinessBackup(b.id, now, { onlyIfDue: true })).lastName ?? "";
    } catch (e) {
      out[b.id] = `failed: ${(e as Error).message}`;
    }
  }
  return out;
}

/** For the Overview: a business's backups are set up but failing or behind. Empty when fine or not set up. */
export function businessBackupWarning(id: string, now = Date.now()): string {
  const s = getBusiness(id)?.backup?.status;
  if (!getBusiness(id)?.backup) return "";
  if (s?.error && (!s.lastOkAt || (s.lastAttemptAt ?? "") > s.lastOkAt)) return `The last backup of this business failed: ${s.error}`;
  if (!s?.lastOkAt) return "";
  if (now - Date.parse(s.lastOkAt) > 2 * EVERY_HOURS * 3_600_000) return `This business's last backup is from ${new Date(s.lastOkAt).toUTCString()}.`;
  return "";
}
