import { decrypt, deriveKey, encrypt } from "./crypto";
import { MASTER_KEY } from "./config";

/**
 * Nothing readable on disk: the state files and the business list are written as one AES-256-GCM blob under a key derived from
 * BLUVFI_MASTER_KEY (a separate derivation from the record and signing keys), which is never in the file. A file from before this
 * (plain JSON) is still read, and is rewritten sealed on the next save. A wrong key or a changed byte is refused, not read as empty.
 */
const PREFIX = "bluvfi-sealed-v1:";
const key = () => {
  if (!/^[0-9a-f]{64}$/i.test(MASTER_KEY)) throw new Error("BLUVFI_MASTER_KEY is not set (64 hex characters)");
  return deriveKey(MASTER_KEY, "state-at-rest");
};

export const sealText = (plain: string) => PREFIX + encrypt(plain, key());

/** The text inside a saved file, and whether it was an old unsealed file. Throws if sealed and the key or the file is wrong. */
export function openText(raw: string): { text: string; legacy: boolean } {
  if (!raw.startsWith(PREFIX)) return { text: raw, legacy: true };
  return { text: decrypt(raw.slice(PREFIX.length).trim(), key()), legacy: false };
}
