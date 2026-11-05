import "./setup";
import { FILE_MASTER_KEY, KEY_DIR } from "./setup-masterkeyfile";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MASTER_KEY, MASTER_KEY_SOURCE } from "../lib/config";
import { readKeyFile, seal, unseal, writeKeyFile } from "../lib/keyfile";

const WALLET = { privateKey: "0x" + "11".repeat(32), token: "t" };

test("keys: the master key can come from a secrets file, which wins over the environment", () => {
  assert.equal(MASTER_KEY, FILE_MASTER_KEY, "read from BLUVFI_MASTER_KEY_FILE, trailing newline trimmed");
  assert.equal(MASTER_KEY_SOURCE, "file");
});

test("keys: a key file sealed under a passphrase opens only with that passphrase", () => {
  const s = seal(WALLET, "correct horse");
  assert.ok(!JSON.stringify(s).includes(WALLET.privateKey), "the key does not appear in the sealed file");
  assert.deepEqual(unseal(s, "correct horse"), WALLET);
  assert.throws(() => unseal(s, "wrong"), /Wrong BLUVFI_KEYFILE_PASSPHRASE/);
});

test("keys: a mainnet key file is never written or kept in plain text", () => {
  const file = join(KEY_DIR, "wallet.json");
  assert.throws(() => writeKeyFile(file, WALLET, { requireSeal: true }), /never written unencrypted/);

  // A plain file left by an older version: refused without a passphrase, encrypted in place with one.
  writeFileSync(file, JSON.stringify(WALLET));
  assert.throws(() => readKeyFile(file, { requireSeal: true }), /plain text/);
  assert.deepEqual(readKeyFile(file, { passphrase: "pw", requireSeal: true }), WALLET);
  const onDisk = readFileSync(file, "utf8");
  assert.ok(!onDisk.includes(WALLET.privateKey), "the plain key is gone from disk");
  assert.match(onDisk, /"sealed": 1/);
  assert.deepEqual(readKeyFile(file, { passphrase: "pw", requireSeal: true }), WALLET);
  assert.throws(() => readKeyFile(file, {}), /is encrypted: set BLUVFI_KEYFILE_PASSPHRASE/);

  // Testnet keeps working without a passphrase.
  const test = join(KEY_DIR, "testnet.json");
  writeKeyFile(test, WALLET, {});
  assert.deepEqual(readKeyFile(test, {}), WALLET);
});
