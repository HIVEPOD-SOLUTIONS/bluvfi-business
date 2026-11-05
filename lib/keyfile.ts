import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Key files for the wallets the app's scripts hold (the x402 payer, the confidential-payout test account): JSON, encrypted
 * at rest under a passphrase that is not on disk (BLUVFI_KEYFILE_PASSPHRASE). scrypt derives the key, AES-256-GCM seals
 * it, so a copied file is useless without the passphrase. Mainnet key files must be encrypted; a plain one written by an
 * older version is encrypted in place the first time it is opened with a passphrase.
 */
export const PASSPHRASE_ENV = "BLUVFI_KEYFILE_PASSPHRASE";

/** `meta` is public, left in the clear (a wallet's address), so status can be shown without the passphrase. */
interface Sealed { sealed: 1; kdf: "scrypt"; n: number; salt: string; iv: string; tag: string; data: string; meta?: Record<string, string> }
const N = 1 << 15;
const derive = (pass: string, salt: Buffer, n: number) => scryptSync(pass, salt, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function seal(value: unknown, passphrase: string, meta?: Record<string, string>): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(passphrase, salt, N), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return { sealed: 1, kdf: "scrypt", n: N, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("hex"), ...(meta ? { meta } : {}) };
}

export function unseal<T>(s: Sealed, passphrase: string): T {
  const d = createDecipheriv("aes-256-gcm", derive(passphrase, Buffer.from(s.salt, "hex"), s.n), Buffer.from(s.iv, "hex"));
  d.setAuthTag(Buffer.from(s.tag, "hex"));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, "hex")), d.final()]).toString("utf8")) as T;
  } catch {
    throw new Error(`Wrong ${PASSPHRASE_ENV}: the key file would not open.`);
  }
}

const isSealed = (v: unknown): v is Sealed => !!v && typeof v === "object" && (v as Sealed).sealed === 1;

/** Writes a key file, encrypted when a passphrase is given. `requireSeal` (mainnet) refuses to write it in the clear. */
export function writeKeyFile(file: string, value: unknown, opts: { passphrase?: string; requireSeal?: boolean; meta?: Record<string, string> }) {
  if (!opts.passphrase && opts.requireSeal) throw new Error(`Set ${PASSPHRASE_ENV} first: a mainnet key file is never written unencrypted.`);
  writeFileSync(file, JSON.stringify(opts.passphrase ? seal(value, opts.passphrase, opts.meta) : value, null, 2), { mode: 0o600 });
}

/** What can be said about a key file without opening it: whether it exists, whether it is sealed, and its public meta. */
export function keyFileInfo(file: string): { exists: boolean; sealed: boolean; meta?: Record<string, string> } {
  if (!existsSync(file)) return { exists: false, sealed: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isSealed(raw) ? { exists: true, sealed: true, meta: raw.meta } : { exists: true, sealed: false };
  } catch {
    return { exists: true, sealed: false };
  }
}

/**
 * Reads a key file. An encrypted one needs the passphrase. A plain one is encrypted in place when a passphrase is given,
 * and refused when `requireSeal` is set without one, so a mainnet wallet key never stays readable as plain text.
 */
export function readKeyFile<T>(file: string, opts: { passphrase?: string; requireSeal?: boolean; meta?: (value: T) => Record<string, string> }): T {
  if (!existsSync(file)) throw new Error(`${file} does not exist.`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (isSealed(raw)) {
    if (!opts.passphrase) throw new Error(`${file} is encrypted: set ${PASSPHRASE_ENV}.`);
    return unseal<T>(raw, opts.passphrase);
  }
  if (opts.passphrase) writeKeyFile(file, raw, { ...opts, meta: opts.meta?.(raw as T) }); // upgrade a plain file written by an older version
  else if (opts.requireSeal) throw new Error(`${file} holds a mainnet key in plain text. Set ${PASSPHRASE_ENV} and run again to encrypt it.`);
  return raw as T;
}
