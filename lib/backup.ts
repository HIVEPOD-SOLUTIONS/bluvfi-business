import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { MASTER_KEY } from "./config";
import { deriveKey } from "./crypto";
import { exclusive, writeAtomic } from "./shared-file";

/**
 * Backups of everything the app keeps: every business's records, the business list, the modes, the verification indexes, the
 * attestation reports and the zero-knowledge proofs (the whole data folder, `.data/` by default).
 *
 *  - Each backup is one file, encrypted with AES-256-GCM under a key derived from BLUVFI_MASTER_KEY, so the storage it sits on
 *    learns nothing, not even the file names inside. Each file inside carries its SHA-256, checked on restore.
 *  - It goes to every destination that is set: a folder (BLUVFI_BACKUP_DIR, best on another disk or a mounted network drive) and/or
 *    any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO...: BLUVFI_BACKUP_S3_*).
 *  - It runs every BLUVFI_BACKUP_EVERY_HOURS (default 24) on its own in each running app (instrumentation.ts) and on the scheduled
 *    settlement poll; a lock shared by all instances makes it run once. Owners can also run one from Settings, or `npm run backup`.
 *  - Backups older than BLUVFI_BACKUP_KEEP_DAYS (default 30) are deleted, but the newest three are always kept.
 *  - `npm run backup -- restore <name>` puts one back (with the app stopped). Without BLUVFI_MASTER_KEY a backup cannot be read, so
 *    keep the master key somewhere else too (a password or secrets manager).
 */

const env = (k: string) => (process.env[k] ?? "").trim();

/** The folder that is backed up: where the records live. */
export const DATA_DIR = env("BLUVFI_BACKUP_SOURCE") || dirname(env("BLUVFI_DATA_FILE") || ".data/state.json");
const STATUS_FILE = join(DATA_DIR, "backup-status.json");
const EVERY_HOURS = Number(env("BLUVFI_BACKUP_EVERY_HOURS") || 24);
const KEEP_DAYS = Number(env("BLUVFI_BACKUP_KEEP_DAYS") || 30);
const MIN_KEEP = 3;
/** v1: base64 JSON (still read). v2: binary, about the size of the data in memory instead of four times it. */
const FORMAT = "bluvfi-backup-v1";
const FORMAT_V2 = "bluvfi-backup-v2";
const NAME = /^bluvfi-backup-(\d{8}T\d{9}Z)\.enc$/;

// ---------- Destinations ----------

export interface Destination {
  label: string;
  put(name: string, body: Buffer): Promise<void>;
  get(name: string): Promise<Buffer>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export function folderDestination(dir: string): Destination {
  return {
    label: `folder ${dir}`,
    async put(name, body) {
      writeAtomic(join(dir, name), body);
    },
    async get(name) {
      return readFileSync(join(dir, name));
    },
    async list() {
      return existsSync(dir) ? readdirSync(dir).filter((f) => NAME.test(f)) : [];
    },
    async remove(name) {
      const { rmSync } = await import("node:fs");
      rmSync(join(dir, name), { force: true });
    },
  };
}

/** AWS Signature Version 4 for S3 (path-style requests, which every S3-compatible service accepts). */
export interface S3Config { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; prefix: string }

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signS3(
  method: string, url: URL, headers: Record<string, string>, payloadHash: string,
  c: { region: string; accessKeyId: string; secretAccessKey: string }, now = new Date(),
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = { ...headers, host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method, url.pathname || "/", query, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** No backup this app makes comes near this; a bigger answer is refused rather than read into memory. */
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

/** `fetcher`: how requests are sent. A business's own bucket uses lib/net-guard.ts publicFetch (checked at connect time). */
export function s3Destination(c: S3Config, fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch): Destination {
  const base = c.endpoint.replace(/\/+$/, "");
  const objectUrl = (name: string) => new URL(`${base}/${rfc3986(c.bucket)}/${`${c.prefix}${name}`.split("/").map(rfc3986).join("/")}`);
  const send = async (method: string, url: URL, body?: Buffer) => {
    const hash = sha256Hex(body ?? "");
    const res = await fetcher(url, { method, redirect: "manual", headers: signS3(method, url, body ? { "content-type": "application/octet-stream" } : {}, hash, c), body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(120_000) });
    if (res.status >= 300 && res.status < 400) throw new Error(`S3 ${method} answered with a redirect (${res.status}), which is not followed`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) throw new Error(`S3 ${method} answer is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB`);
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new Error(`S3 ${method} answered ${res.status}${code ? ` (${code})` : ""}`);
    }
    return res;
  };
  return {
    label: `S3 bucket ${c.bucket} at ${new URL(base).host}`,
    async put(name, body) {
      await send("PUT", objectUrl(name), body);
    },
    async get(name) {
      return Buffer.from(await (await send("GET", objectUrl(name))).arrayBuffer());
    },
    async list() {
      const out: string[] = [];
      let token = "";
      do {
        const url = new URL(`${base}/${rfc3986(c.bucket)}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", c.prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const xml = await (await send("GET", url)).text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const name = m[1].slice(c.prefix.length);
          if (NAME.test(name)) out.push(name);
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
      } while (token);
      return out;
    },
    async remove(name) {
      await send("DELETE", objectUrl(name));
    },
  };
}

/** The destinations set in the environment. */
export function destinations(): Destination[] {
  const out: Destination[] = [];
  if (env("BLUVFI_BACKUP_DIR")) out.push(folderDestination(env("BLUVFI_BACKUP_DIR")));
  if (env("BLUVFI_BACKUP_S3_BUCKET")) {
    const need = ["BLUVFI_BACKUP_S3_ENDPOINT", "BLUVFI_BACKUP_S3_ACCESS_KEY_ID", "BLUVFI_BACKUP_S3_SECRET_ACCESS_KEY"].filter((k) => !env(k));
    if (need.length) throw new Error(`BLUVFI_BACKUP_S3_BUCKET is set but ${need.join(", ")} ${need.length === 1 ? "is" : "are"} not`);
    if (!/^https?:\/\//.test(env("BLUVFI_BACKUP_S3_ENDPOINT"))) throw new Error("BLUVFI_BACKUP_S3_ENDPOINT must be a URL such as https://s3.eu-west-1.amazonaws.com");
    out.push(s3Destination({
      endpoint: env("BLUVFI_BACKUP_S3_ENDPOINT"), bucket: env("BLUVFI_BACKUP_S3_BUCKET"), region: env("BLUVFI_BACKUP_S3_REGION") || "us-east-1",
      accessKeyId: env("BLUVFI_BACKUP_S3_ACCESS_KEY_ID"), secretAccessKey: env("BLUVFI_BACKUP_S3_SECRET_ACCESS_KEY"),
      prefix: env("BLUVFI_BACKUP_S3_PREFIX") || "bluvfi/",
    }));
  }
  return out;
}
export const backupsConfigured = () => !!(env("BLUVFI_BACKUP_DIR") || env("BLUVFI_BACKUP_S3_BUCKET"));

// ---------- Making and reading a backup ----------

interface FileEntry { path: string; size: number; sha256: string; data: string }
interface Bundle { format: typeof FORMAT; createdAt: string; source: string; files: FileEntry[] }
/** One file of an opened backup, its bytes checked against its SHA-256. */
export interface OpenedFile { path: string; size: number; sha256: string; bytes: Buffer }
export interface Opened { format: string; createdAt: string; source: string; files: OpenedFile[] }

const backupKey = () => {
  if (!/^[0-9a-f]{64}$/i.test(MASTER_KEY)) throw new Error("BLUVFI_MASTER_KEY is not set, so there is nothing to encrypt a backup with");
  return deriveKey(MASTER_KEY, "backup-encryption");
};
/** A short fingerprint of the backup key, kept beside the ciphertext, so a restore with the wrong master key says so plainly. */
const keyId = (key: string) => sha256Hex(`bluvfi-backup-key-id:${key}`).slice(0, 12);
const toPosix = (p: string) => p.split(sep).join("/");

/** AES-256-GCM over the compressed bytes: iv (12) | tag (16) | ciphertext. (v1 backups held the same, as base64.) */
function sealRaw(plain: Buffer, keyHex: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function unseal(sealed: string | Buffer, keyHex: string): Buffer {
  const raw = typeof sealed === "string" ? Buffer.from(sealed, "base64") : sealed;
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

/**
 * Everything to back up: the data folder, without locks, half-written temp files, the public OFAC cache, the backup status, and
 * the zero-knowledge proving-key cache (zk/cache: tens of MB that o1js rebuilds by itself in about 20 s).
 */
function collect(): OpenedFile[] {
  const root = resolve(DATA_DIR);
  if (!existsSync(root)) return [];
  const skipDir = env("BLUVFI_BACKUP_DIR") ? resolve(env("BLUVFI_BACKUP_DIR")) : "";
  const out: OpenedFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      // Locks, temp files and the safety copies a restore leaves beside the records (.before-restore-*) are not backed up.
      if (name.endsWith(".lock") || name.endsWith(".tmp") || name.includes(".before-restore-") || full === skipDir) continue;
      if (dir === root && (name === "sanctions.json" || name === "backup-status.json")) continue;
      if (dir === join(root, "zk") && name === "cache") continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const data = readFileSync(full);
        out.push({ path: toPosix(relative(root, full)), size: data.length, sha256: sha256Hex(data), bytes: data });
      }
    }
  };
  walk(root);
  return out;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(".", "");
export const backupName = (d: Date) => `bluvfi-backup-${stamp(d)}.enc`;
export const backupTime = (name: string): number => {
  const m = NAME.exec(name);
  if (!m) return NaN;
  const s = m[1];
  return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`);
};

export function makeBackup(now = new Date()): { name: string; body: Buffer; files: number; bytes: number } {
  const files = collect();
  // Paths inside are relative to the data folder, so a backup restores into whatever folder holds the records now.
  // v2: a length-prefixed JSON header (paths, sizes, checksums) then every file's bytes, gzipped and sealed as binary.
  const header = Buffer.from(JSON.stringify({ format: FORMAT_V2, createdAt: now.toISOString(), source: toPosix(resolve(DATA_DIR)), files: files.map(({ bytes: _b, ...m }) => (void _b, m)) }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const key = backupKey();
  const sealed = sealRaw(gzipSync(Buffer.concat([len, header, ...files.map((f) => f.bytes)])), key);
  return { name: backupName(now), body: Buffer.concat([Buffer.from(`${FORMAT_V2}\n${keyId(key)}\n`), sealed]), files: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
}

/** Open a backup and check every file in it against its SHA-256. Throws, with the reason, if anything is wrong. */
export function openBackup(body: Buffer): Opened {
  const nl1 = body.indexOf(10);
  const nl2 = nl1 < 0 ? -1 : body.indexOf(10, nl1 + 1);
  const format = nl1 < 0 ? "" : body.subarray(0, nl1).toString("utf8");
  if ((format !== FORMAT && format !== FORMAT_V2) || nl2 < 0) throw new Error("This is not a Bluvfi Business backup (or it is cut short)");
  const id = body.subarray(nl1 + 1, nl2).toString("utf8");
  const key = backupKey();
  if (id !== keyId(key)) throw new Error("This backup was made with a different BLUVFI_MASTER_KEY. Set the master key it was made with to read it.");
  let opened: Opened;
  try {
    if (format === FORMAT) {
      const bundle = JSON.parse(gunzipSync(unseal(body.subarray(nl2 + 1).toString("utf8").trim(), key)).toString("utf8")) as Bundle;
      opened = { ...bundle, files: bundle.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, bytes: Buffer.from(f.data, "base64") })) };
    } else {
      const plain = gunzipSync(unseal(body.subarray(nl2 + 1), key));
      const hlen = plain.readUInt32BE(0);
      const head = JSON.parse(plain.subarray(4, 4 + hlen).toString("utf8")) as Omit<Opened, "files"> & { files: Omit<OpenedFile, "bytes">[] };
      let at = 4 + hlen;
      opened = { ...head, files: head.files.map((f) => ({ ...f, bytes: plain.subarray(at, (at += f.size)) })) };
    }
  } catch {
    throw new Error("This backup is damaged: it does not decrypt");
  }
  for (const f of opened.files) {
    if (sha256Hex(f.bytes) !== f.sha256) throw new Error(`This backup is damaged: ${f.path} does not match its checksum`);
  }
  return opened;
}

// ---------- Running, keeping, restoring ----------

export interface BackupStatus {
  configured: boolean;
  destinations: string[];
  everyHours: number;
  keepDays: number;
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastName?: string;
  lastFiles?: number;
  lastBytes?: number;
  results?: { destination: string; ok: boolean; error?: string; deleted?: number }[];
}

export function backupStatus(): BackupStatus {
  let saved: Partial<BackupStatus> = {};
  try {
    if (existsSync(STATUS_FILE)) saved = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as Partial<BackupStatus>;
  } catch {
    /* unreadable: shown as never backed up */
  }
  let labels: string[] = [];
  try {
    labels = destinations().map((d) => d.label);
  } catch (e) {
    labels = [`misconfigured: ${(e as Error).message}`];
  }
  return { ...saved, configured: backupsConfigured(), destinations: labels, everyHours: EVERY_HOURS, keepDays: KEEP_DAYS };
}

/** Too old, failing, or off: what the Overview and Settings warn about. Empty when all is well. */
export function backupWarning(now = Date.now()): string {
  const s = backupStatus();
  if (!s.configured) return "Backups are off. Set BLUVFI_BACKUP_DIR (a folder on another disk) or an S3-compatible bucket (BLUVFI_BACKUP_S3_*), so a lost disk does not lose your records.";
  if (s.destinations.some((d) => d.startsWith("misconfigured"))) return `Backups are misconfigured: ${s.destinations[0].replace(/^misconfigured: /, "")}.`;
  const failed = s.results?.filter((r) => !r.ok) ?? [];
  if (failed.length) return `The last backup failed for ${failed.map((r) => `${r.destination} (${r.error})`).join(", ")}.`;
  if (!s.lastOkAt) return "No backup has been made yet.";
  if (now - Date.parse(s.lastOkAt) > 2 * EVERY_HOURS * 3_600_000) return `The last backup is from ${new Date(s.lastOkAt).toUTCString()}, more than ${2 * EVERY_HOURS} hours ago.`;
  return "";
}

/** Delete backups older than the retention period, but always keep the newest MIN_KEEP. */
export async function prune(d: Destination, now = Date.now()): Promise<number> {
  const names = (await d.list()).filter((n) => Number.isFinite(backupTime(n))).sort((a, b) => backupTime(b) - backupTime(a));
  const old = names.slice(MIN_KEEP).filter((n) => now - backupTime(n) > KEEP_DAYS * 86_400_000);
  for (const n of old) await d.remove(n);
  return old.length;
}

/** Make one backup and send it to every destination. Runs once at a time across every instance of the app. */
export async function runBackup(now = new Date(), opts: { onlyIfDue?: boolean } = {}): Promise<BackupStatus> {
  const dests = destinations();
  if (!dests.length) throw new Error("No backup destination is set: BLUVFI_BACKUP_DIR or BLUVFI_BACKUP_S3_*");
  mkdirSync(DATA_DIR, { recursive: true });
  return exclusive("backup", STATUS_FILE, async () => {
    if (opts.onlyIfDue && !isDue(now)) return backupStatus(); // another instance just made it
    const b = makeBackup(now);
    const results: NonNullable<BackupStatus["results"]> = [];
    for (const d of dests) {
      try {
        await d.put(b.name, b.body);
        // Read it back and open it: a backup that cannot be restored is not a backup.
        openBackup(await d.get(b.name));
        results.push({ destination: d.label, ok: true, deleted: await prune(d, now.getTime()) });
      } catch (e) {
        results.push({ destination: d.label, ok: false, error: (e as Error).message });
      }
    }
    const prev = backupStatus();
    const anyOk = results.some((r) => r.ok);
    const next: Partial<BackupStatus> = {
      lastAttemptAt: now.toISOString(),
      lastOkAt: anyOk ? now.toISOString() : prev.lastOkAt,
      lastName: anyOk ? b.name : prev.lastName,
      lastFiles: anyOk ? b.files : prev.lastFiles,
      lastBytes: anyOk ? b.body.length : prev.lastBytes,
      results,
    };
    writeAtomic(STATUS_FILE, JSON.stringify(next, null, 2));
    return backupStatus();
  });
}

const isDue = (now: Date) => {
  const last = backupStatus().lastOkAt;
  return !last || now.getTime() - Date.parse(last) >= EVERY_HOURS * 3_600_000;
};

/** Run a backup if one is due (none yet, or the last good one is older than BLUVFI_BACKUP_EVERY_HOURS). Never throws. */
export async function backupIfDue(now = new Date()): Promise<{ ran: boolean; status?: BackupStatus; error?: string }> {
  if (!backupsConfigured() || !(EVERY_HOURS > 0)) return { ran: false };
  if (!isDue(now)) return { ran: false };
  try {
    return { ran: true, status: await runBackup(now, { onlyIfDue: true }) };
  } catch (e) {
    return { ran: true, error: (e as Error).message };
  }
}

/** Every backup at every destination, newest first. */
export async function listBackups(): Promise<{ destination: string; name: string; at: string }[]> {
  const out: { destination: string; name: string; at: string }[] = [];
  for (const d of destinations()) for (const name of await d.list()) out.push({ destination: d.label, name, at: new Date(backupTime(name)).toISOString() });
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Read a backup: a file path, or a backup's name looked up at each destination in turn. */
export async function fetchBackup(nameOrPath: string): Promise<Buffer> {
  if (existsSync(nameOrPath)) return readFileSync(nameOrPath);
  const errors: string[] = [];
  for (const d of destinations()) {
    try {
      return await d.get(nameOrPath);
    } catch (e) {
      errors.push(`${d.label}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Backup ${nameOrPath} was not found${errors.length ? ` (${errors.join("; ")})` : ""}`);
}

/**
 * Put a backup's files back. With `to`, into that folder (to look inside safely). Otherwise into the data folder: the current one is
 * first moved aside to <folder>.before-restore-<time> (never deleted), and only with `force` if it already holds records.
 * Stop the app first, or it will keep writing the records it has in memory.
 */
export function restoreBackup(body: Buffer, opts: { to?: string; force?: boolean; now?: Date } = {}): { files: number; createdAt: string; movedAside?: string; into: string } {
  const bundle = openBackup(body);
  const into = resolve(opts.to ?? DATA_DIR);
  for (const f of bundle.files) {
    if (isAbsolute(f.path) || f.path.split("/").includes("..")) throw new Error(`Refusing a path outside the folder: ${f.path}`);
  }
  let movedAside: string | undefined;
  if (!opts.to) {
    const dataDir = into;
    const holdsRecords = existsSync(dataDir) && readdirSync(dataDir).some((n) => !n.endsWith(".lock"));
    if (holdsRecords) {
      if (!opts.force) throw new Error(`${DATA_DIR} already holds records. Stop the app, then run again with --force: the current folder is moved aside, not deleted.`);
      movedAside = `${dataDir}.before-restore-${stamp(opts.now ?? new Date())}`;
      try {
        renameSync(dataDir, movedAside);
      } catch (e) {
        // A mount point (a Docker volume) cannot be renamed: move what is in it into a folder inside it instead.
        if (!["EBUSY", "EXDEV", "EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        const inside = join(dataDir, `.before-restore-${stamp(opts.now ?? new Date())}`);
        mkdirSync(inside);
        for (const n of readdirSync(dataDir)) if (join(dataDir, n) !== inside) renameSync(join(dataDir, n), join(inside, n));
        movedAside = inside;
      }
    }
  }
  for (const f of bundle.files) {
    const target = join(into, ...f.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, f.bytes);
  }
  return { files: bundle.files.length, createdAt: bundle.createdAt, movedAside, into };
}
