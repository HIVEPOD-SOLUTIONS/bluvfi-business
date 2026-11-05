import "./setup";
import { WALLETS_ROOT } from "./setup-wallets";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIDENTIAL_FILE, createWallet, encryptWallet, openPayer, payerFile, revealPayerToken, walletsStatus } from "../lib/wallets";

/** Balance lookups answered locally: 2.5 USDC on Base, 0.1 NEAR on NEAR. */
async function withBalances(body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const result = u.includes("base.org") ? "0x" + (2_500_000).toString(16) : { amount: "100000000000000000000000" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const PASS = "a long enough passphrase";

test("wallets: a new wallet is sealed, its address is public, and nothing is shown that needs the passphrase", async () => {
  assert.throws(() => createWallet("payer-mainnet", "short"), /at least 12 characters/);
  assert.throws(() => createWallet("payer-mainnet"), /Enter the passphrase/);
  const { address } = createWallet("payer-mainnet", PASS);
  const raw = readFileSync(payerFile("mainnet"), "utf8");
  assert.match(raw, /"sealed": 1/);
  assert.ok(!/0x[0-9a-f]{64}/i.test(raw.replace(/"data": "[0-9a-f]+"/, "")), "no private key in the clear");
  assert.ok(raw.includes(address), "the address is kept in the clear for status");
  assert.throws(() => createWallet("payer-mainnet", PASS), /already exists/);

  await withBalances(async () => {
    const st = (await walletsStatus()).find((w) => w.id === "payer-mainnet")!;
    assert.deepEqual([st.exists, st.sealed, st.address, st.balance?.amount, st.balance?.unit], [true, true, address, 2.5, "USDC"]);
  });
});

test("wallets: the payer's token and key open only with the passphrase", () => {
  assert.throws(() => revealPayerToken("payer-mainnet", "the wrong passphrase"), /Wrong BLUVFI_KEYFILE_PASSPHRASE/);
  const { token } = revealPayerToken("payer-mainnet", PASS);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(openPayer("mainnet", PASS).token, token, "the scripts open the same file the page made");
  assert.throws(() => revealPayerToken("confidential-mainnet", PASS), /Only the payer has a token/);
});

test("wallets: a plain key file from an older version is flagged, then encrypted in place from the page", async () => {
  const key = "0x" + "22".repeat(32);
  mkdirSync(join(WALLETS_ROOT, ".testnet"), { recursive: true });
  writeFileSync(payerFile("testnet"), JSON.stringify({ privateKey: key, token: "old-token" }));
  await withBalances(async () => {
    const st = (await walletsStatus()).find((w) => w.id === "payer-testnet")!;
    assert.deepEqual([st.exists, st.sealed, st.mustSeal], [true, false, false]);
    assert.equal(st.address, privateKeyToAccount(key as `0x${string}`).address, "a plain file's address is read from it");
  });
  encryptWallet("payer-testnet", PASS);
  const raw = readFileSync(payerFile("testnet"), "utf8");
  assert.ok(!raw.includes(key.slice(2)), "the plain key is gone from disk");
  assert.ok(raw.includes(privateKeyToAccount(key as `0x${string}`).address), "and the address is kept in the clear");
  assert.equal(revealPayerToken("payer-testnet", PASS).token, "old-token");
  assert.throws(() => encryptWallet("payer-testnet", PASS), /already encrypted/);
});

test("wallets: the confidential-test account is a sealed NEAR implicit account", async () => {
  const { address } = createWallet("confidential-mainnet", PASS);
  assert.match(address, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(CONFIDENTIAL_FILE, "utf8"), /"sealed": 1/);
  await withBalances(async () => {
    const st = (await walletsStatus()).find((w) => w.id === "confidential-mainnet")!;
    assert.deepEqual([st.sealed, st.address, st.balance?.amount, st.balance?.unit], [true, address, 0.1, "NEAR"]);
  });
  assert.throws(() => createWallet("nonsense", PASS), /Unknown wallet/);
});
