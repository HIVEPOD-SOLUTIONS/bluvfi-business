import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";

// Sanctions screening against the REAL OFAC SDN list, downloaded from the US Treasury. Nothing faked.
const T = { timeout: 240_000 };

test("the real OFAC list is downloaded and indexed: names, aliases and crypto addresses", T, async () => {
  const { loadSanctions } = await import("../../lib/sanctions");
  const idx = await loadSanctions(true);
  assert.ok(idx, "the list loaded");
  assert.ok(Object.keys(idx.entities).length > 10_000, "thousands of listings");
  assert.ok(Object.keys(idx.addresses).length > 300, "hundreds of listed crypto addresses");
  assert.ok(idx.names.length > Object.keys(idx.entities).length, "aliases are indexed too");
  assert.match(idx.listDate, /^\d{4}-\d{2}-\d{2}$/);
  const currencies = new Set(Object.values(idx.addresses).map((a) => a[1]));
  for (const c of ["ETH", "XBT", "TRX", "USDT"]) assert.ok(currencies.has(c), `${c} addresses are listed`);
});

test("a payout to a sanctioned address is a hit, whatever the letter case, and a clean address is clear", T, async () => {
  const { screenSanctions } = await import("../../lib/sanctions");
  // Lazarus Group (North Korea), listed by OFAC.
  const lazarus = await screenSanctions({ address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" });
  assert.equal(lazarus.status, "hit");
  assert.equal(lazarus.hits[0].kind, "address");
  assert.match(lazarus.hits[0].entity, /LAZARUS/i);
  assert.equal((await screenSanctions({ address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96" })).status, "hit", "EVM addresses are case-insensitive");
  const clean = await screenSanctions({ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", name: "Northwind Cloud Ltd" });
  assert.equal(clean.status, "clear");
  assert.match(clean.note, /Not on the OFAC list dated/);
});

test("a listed name is flagged for a person to confirm, including near matches, and ordinary names are not", T, async () => {
  const { screenSanctions } = await import("../../lib/sanctions");
  const exact = await screenSanctions({ name: "Lazarus Group" });
  assert.equal(exact.status, "hit");
  assert.equal(exact.hits[0].kind, "name");
  assert.equal(exact.hits[0].exact, true);
  const near = await screenSanctions({ name: "Lazarus Grup" });
  assert.equal(near.status, "hit", "one typo still matches");
  assert.equal(near.hits[0].exact, false);
  for (const ok of ["Northwind Cloud Ltd", "Acme Logistics", "Brightline Design Studio"]) assert.equal((await screenSanctions({ name: ok })).status, "clear", ok);
});

test("the whole check engine blocks a payout to a sanctioned address and warns on a listed vendor name, with real data", T, async () => {
  const { publicCheck } = await import("../../lib/agent");
  const addr = await publicCheck({ payoutAddress: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", chain: "eth", vendorName: "Some Vendor", vendorDomain: "vendor.example" });
  assert.equal(addr.verdict, "block");
  const c = addr.checks.find((x) => x.id === "sanctions")!;
  assert.equal(c.verdict, "block");
  assert.match(c.reason, /OFAC sanctions list/);
  const name = await publicCheck({ payoutAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", chain: "eth", vendorName: "Lazarus Group", vendorDomain: "x.example" });
  assert.equal(name.checks.find((x) => x.id === "sanctions")!.verdict, "warn");
});
