import { DIR } from "./setup-vault";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cfg, createBusiness, resetRegistry, businesses, setChannels } from "../lib/business";
import { deriveKey, encrypt } from "../lib/crypto";
import { persist, resetAllState, resetState, state, withRecords } from "../lib/store";
import { runAs } from "../lib/tenant";
import type { Vendor } from "../lib/types";

const STATE = join(DIR, "state.json");
const REGISTRY = join(DIR, "businesses.json");
const SECRETS = ["Secret Vendor GmbH", "secret-vendor.example", "0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912", "INV-SECRET-77"];
const vendor = { name: SECRETS[0], domain: SECRETS[1], payout: { address: SECRETS[2], chain: "eth" }, paidInvoiceNumbers: [SECRETS[3]] } as unknown as Vendor;

test("the saved records are one sealed blob: no vendor, address or invoice number can be read from the file", () => {
  runAs("default", () => {
    state().vendors.push(vendor);
    persist();
  });
  const raw = readFileSync(STATE, "utf8");
  assert.match(raw, /^bluvfi-sealed-v1:/);
  for (const s of SECRETS) assert.ok(!raw.includes(s), `${s} is readable on disk`);
  assert.ok(!raw.includes("payments"), "not even the field names are readable");
});

test("sealed records are read back exactly, after the app forgets them", () => {
  resetAllState();
  runAs("default", () => assert.deepEqual(state().vendors.map((v) => v.name), [SECRETS[0]]));
});

test("a reset is not undone by the file on disk: the next locked write starts from the empty records (demo:ui run twice)", async () => {
  await runAs("default", async () => {
    resetAllState();
    assert.equal(state().vendors.length, 1, "the earlier run's records are on disk");
    // A new process (npm run demo:ui again) has never read the file: it resets first.
    resetAllState();
    delete (globalThis as { __bluvfiStamps?: unknown }).__bluvfiStamps;
    resetState();
    const seen = await withRecords(() => state().vendors.length);
    assert.equal(seen, 0, "withRecords did not load the old file back over the reset");
    resetAllState();
    assert.equal(state().vendors.length, 0, "and the empty records were saved");
    state().vendors.push(vendor);
    persist();
  });
});

test("a file from before sealing (plain JSON) is still read, and is sealed on first read", () => {
  const plain = JSON.stringify({ vendors: [vendor], payments: [] });
  writeFileSync(STATE, plain);
  resetAllState();
  runAs("default", () => assert.equal(state().vendors[0].name, SECRETS[0]));
  const raw = readFileSync(STATE, "utf8");
  assert.match(raw, /^bluvfi-sealed-v1:/, "rewritten sealed");
  assert.ok(!raw.includes(SECRETS[0]));
});

test("a changed byte, or a file sealed with another key, is refused, never read as empty", () => {
  runAs("default", () => persist());
  const good = readFileSync(STATE, "utf8");
  // One byte changed inside the ciphertext.
  const flipped = good.slice(0, -2) + (good.endsWith("00") ? "11" : "00");
  writeFileSync(STATE, flipped);
  resetAllState();
  assert.throws(() => runAs("default", () => state()), /unreadable/);
  assert.equal(readFileSync(STATE, "utf8"), flipped, "the file was left alone");
  // Sealed with someone else's key.
  writeFileSync(STATE, "bluvfi-sealed-v1:" + encrypt("{}", deriveKey("cd".repeat(32), "state-at-rest")));
  resetAllState();
  assert.throws(() => runAs("default", () => state()), /unreadable/);
});

test("the list of businesses is sealed too: names, emails and channel settings are not readable on disk", () => {
  resetRegistry();
  const b = createBusiness("Hidden Holdings Ltd", "founder@hidden-holdings.example");
  setChannels(b.id, { telegramBotToken: "123456789:AAsecretBotTokenValue0123456789abcdefg" }, { telegramWebhookSecret: "hooksecret0123456789" });
  const raw = readFileSync(REGISTRY, "utf8");
  assert.match(raw, /^bluvfi-sealed-v1:/);
  for (const s of ["Hidden Holdings", "founder@hidden-holdings.example", "secretBotTokenValue"]) assert.ok(!raw.includes(s), `${s} is readable on disk`);
  delete (globalThis as { __bluvfiRegistry?: unknown }).__bluvfiRegistry; // the app forgets the list, then reads the file
  assert.deepEqual(businesses().filter((x) => x.id === b.id).map((x) => x.name), ["Hidden Holdings Ltd"]);
  assert.ok(existsSync(REGISTRY));
  void cfg;
});
