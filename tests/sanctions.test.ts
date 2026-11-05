import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { processInvoice, publicCheck } from "../lib/agent";
import { buildIndex, normalizeName, parseCsv, resetSanctions, screenSanctions, useSanctionsIndex } from "../lib/sanctions";
import { services } from "../lib/services";
import { install, invoice, seed, state } from "./fakes";

// A small list in OFAC's own CSV layout (SDN: id, name, type, program, title, call sign, vessel type, tonnage, grt, flag, owner, remarks).
const SDN = [
  `100,"EVIL TRADING CO., LTD.",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Digital Currency Address - ETH 0xAbCdEf0123456789aBcDeF0123456789AbCdEf01; alt. Digital Currency Address - USDT TXyz123abcDEF; Linked To: BAD ""QUOTED"" PERSON."`,
  `200,"MARIA GARCIA LOPEZ","individual","CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
  `300,"SHADOW EXCHANGE",-0- ,"CYBER2",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Digital Currency Address - XBT bc1qSHADOWcaseSENSITIVE0000000000"`,
].join("\n");
const ALT = [`100,1,"aka","NIGHT HARBOR IMPORTS",-0- `, `999,1,"aka","ORPHAN ALIAS",-0- `].join("\n");

beforeEach(() => { install(); seed(); resetSanctions(); useSanctionsIndex(buildIndex(SDN, ALT, "2026-11-04")); });

test("OFAC's CSV is read correctly: quoted commas, doubled quotes, -0- blanks, and the address list in the remarks", () => {
  assert.deepEqual(parseCsv('1,"A, B","say ""hi""",-0- \n2,"x",,\r\n'), [["1", "A, B", 'say "hi"', "-0- "], ["2", "x", "", ""]]);
  const idx = buildIndex(SDN, ALT, "2026-11-04");
  assert.equal(Object.keys(idx.entities).length, 3);
  assert.deepEqual(idx.addresses["0xabcdef0123456789abcdef0123456789abcdef01"], ["100", "ETH"], "EVM keys are lowercased");
  assert.deepEqual(idx.addresses.TXyz123abcDEF, ["100", "USDT"], "the alt. address on the same listing is read too");
  assert.ok(idx.names.some(([n, e]) => n === "night harbor imports" && e === "100"), "aliases are indexed");
  assert.ok(!idx.names.some(([n]) => n === "orphan alias"), "an alias of an unknown listing is dropped");
});

test("names are compared without accents, punctuation or company-form words", () => {
  assert.equal(normalizeName("Évil Trading Co., Ltd."), "evil trading");
  assert.equal(normalizeName("EVIL  TRADING"), "evil trading");
});

test("an address match is certain (and case-insensitive for EVM, exact for the rest); a clean address is clear", async () => {
  assert.equal((await screenSanctions({ address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" })).status, "hit");
  assert.equal((await screenSanctions({ address: "TXyz123abcDEF" })).status, "hit");
  assert.equal((await screenSanctions({ address: "txyz123abcdef" })).status, "clear", "Tron addresses are case-sensitive");
  assert.equal((await screenSanctions({ address: "bc1qSHADOWcaseSENSITIVE0000000000" })).status, "hit");
  const clean = await screenSanctions({ address: "0x1111111111111111111111111111111111111111" });
  assert.deepEqual([clean.status, clean.listDate], ["clear", "2026-11-04"]);
});

test("a name match covers aliases and one-typo near matches, and flags an exact one as exact", async () => {
  const exact = await screenSanctions({ name: "Evil Trading Co Ltd" });
  assert.equal(exact.hits[0].exact, true);
  assert.equal((await screenSanctions({ name: "Night Harbor Imports" })).status, "hit", "by alias");
  const near = await screenSanctions({ name: "Shadow Exchenge" });
  assert.equal(near.status, "hit");
  assert.equal(near.hits[0].exact, false);
  assert.equal((await screenSanctions({ name: "Maria Garcia" })).status, "clear", "a different, shorter name");
  assert.equal((await screenSanctions({ name: "Evil" })).status, "clear", "very short names are not matched");
});

test("in the check engine a listed address blocks, a listed name warns, and no list at all warns that nothing was screened", async () => {
  services.screenSanctions = screenSanctions;
  const addr = await processInvoice(invoice({ invoiceNumber: "INV-S1", payoutAddress: "0xabcdef0123456789abcdef0123456789abcdef01", chain: "eth" }));
  const c = addr.checks.find((x) => x.id === "sanctions")!;
  assert.deepEqual([c.verdict, addr.status], ["block", "blocked"]);
  assert.match(c.reason, /OFAC sanctions list/);
  assert.match(addr.headline, /sanctions list/);

  const named = await publicCheck({ payoutAddress: "0x1111111111111111111111111111111111111111", chain: "eth", vendorName: "Shadow Exchange", vendorDomain: "shadow.example" });
  assert.equal(named.checks.find((x) => x.id === "sanctions")!.verdict, "warn");

  services.screenSanctions = async () => { throw new Error("offline"); };
  const down = await publicCheck({ payoutAddress: "0x1111111111111111111111111111111111111111", chain: "eth", vendorName: "Northwind Cloud Ltd", vendorDomain: "northwind.io" });
  const d = down.checks.find((x) => x.id === "sanctions")!;
  assert.equal(d.verdict, "warn");
  assert.match(d.reason, /NOT screened/);
});

test("a payee who became listed after intake is stopped when the money would move", async () => {
  let listed = false;
  services.screenSanctions = async (i: { address?: string; name?: string }) =>
    listed ? screenSanctions(i) : { status: "clear" as const, hits: [], note: "clear at intake" };
  const { release } = await import("../lib/agent");
  state().vendors[0].payout = { chain: "eth", asset: "USDC", address: "0xabcdef0123456789abcdef0123456789abcdef01" }; // the vendor is paid there, so nothing else blocks it
  const p = await processInvoice(invoice({ invoiceNumber: "INV-S2", payoutAddress: "0xabcdef0123456789abcdef0123456789abcdef01", chain: "eth" }));
  assert.notEqual(p.status, "blocked", "clear at intake");
  listed = true;
  await release(p);
  assert.equal(p.status, "blocked");
  assert.match(p.headline, /Blocked at release: payee is on a sanctions list/);
});
