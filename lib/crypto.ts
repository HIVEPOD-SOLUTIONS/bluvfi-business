import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { slh_dsa_sha2_128f } from "@noble/post-quantum/slh-dsa.js";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^(ed25519:|0x)/, ""), "hex"));
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Derive a purpose-bound 32-byte key from the master key. */
export const deriveKey = (masterHex: string, purpose: string) =>
  createHmac("sha256", Buffer.from(masterHex, "hex")).update(`bluvfi-business:${purpose}`).digest("hex");

/** JSON with sorted keys, so a hash of it never depends on property order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function ed25519Verify(signatureHex: string, message: string, publicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signatureHex), new TextEncoder().encode(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** Test helper: an ed25519 key from a 32-byte hex seed. Not used by the app itself. */
export function ed25519KeyFromSeed(seedHex: string) {
  const secret = hexToBytes(seedHex);
  return {
    publicKeyHex: bytesToHex(ed25519.getPublicKey(secret)),
    sign: (msg: string) => bytesToHex(ed25519.sign(new TextEncoder().encode(msg), secret)),
  };
}

/** Post-quantum signature (ML-DSA-65) over an audit record, from a seed derived from the master key. */
export function mlDsaSign(message: string, seedHex: string) {
  const { secretKey, publicKey } = ml_dsa65.keygen(hexToBytes(seedHex));
  const sig = ml_dsa65.sign(new TextEncoder().encode(message), secretKey);
  return { publicKey: bytesToHex(publicKey), signature: bytesToHex(sig) };
}
export const mlDsaPublicKey = (seedHex: string) => bytesToHex(ml_dsa65.keygen(hexToBytes(seedHex)).publicKey);

// SLH-DSA key generation takes ~25 ms, so each seed's key pair is made once per process.
const slhKeys = new Map<string, { secretKey: Uint8Array; publicKey: Uint8Array }>();
const slhKeyPair = (seedHex: string) => {
  let k = slhKeys.get(seedHex);
  if (!k) slhKeys.set(seedHex, (k = slh_dsa_sha2_128f.keygen(hexToBytes(seedHex))));
  return k;
};

/** Hash-based post-quantum signature (SLH-DSA-SHA2-128f, FIPS 205): secure as long as SHA-256 is. Seed: 48 bytes hex. */
export function slhDsaSign(message: string, seedHex: string) {
  const { secretKey, publicKey } = slhKeyPair(seedHex);
  return { publicKey: bytesToHex(publicKey), signature: bytesToHex(slh_dsa_sha2_128f.sign(new TextEncoder().encode(message), secretKey)) };
}
export const slhDsaPublicKey = (seedHex: string) => bytesToHex(slhKeyPair(seedHex).publicKey);
export function slhDsaVerify(signatureHex: string, message: string, publicKeyHex: string) {
  try {
    return slh_dsa_sha2_128f.verify(hexToBytes(signatureHex), new TextEncoder().encode(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function mlDsaVerify(signatureHex: string, message: string, publicKeyHex: string) {
  try {
    return ml_dsa65.verify(hexToBytes(signatureHex), new TextEncoder().encode(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** AES-256-GCM, used for audit records that are encrypted at rest. */
export function encrypt(plain: string, keyHex: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}
export function decrypt(blob: string, keyHex: string) {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "hex"));
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
export const newKeyHex = () => randomBytes(32).toString("hex");
