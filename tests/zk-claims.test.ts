import "./setup";
import "./setup-zk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { createBusiness, setBusinessKyb } from "../lib/business";
import { buildIndex } from "../lib/sanctions";
import { services } from "../lib/services";
import { runAs } from "../lib/tenant";
import { attest, type AttesterSources } from "../lib/zk-attester";
import { addressLeaf, CLAIMS_VK_FILE, compileClaim, issuerPublicKey, listGaps, MAX_TOTAL_GATES, nameCommitment, nameGaps, payeeCommitment, prepareCircuit, prepareCredential, prepareName, prepareSanctions, prepareSolvency, proveClaim, subjectOf, verifyClaim, type ClaimArtifact } from "../lib/zk-claims";
import { install, seed, state } from "./fakes";

// Real o1js proofs, nothing mocked. Each proof takes a while; the circuits are compiled once and cached.
const T = { timeout: 1_200_000 };
const LISTED = ["0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", "TXyz123abcDEF", "bc1qSHADOWcaseSENSITIVE0000000000", "0x098B716B8Aaf21512996dC57EB0615e2383E2f96"];
const idx = () =>
  buildIndex(
    `100,"EVIL TRADING CO., LTD.",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"${LISTED.map((a, i) => `${i ? "alt. " : ""}Digital Currency Address - ETH ${a}`).join("; ")}"\n200,"SHADOW EXCHANGE",-0- ,"CYBER2",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
    `100,1,"aka","NIGHT HARBOR IMPORTS",-0- `,
    "2026-11-04",
  );
const CLEAN = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const subject = subjectOf("payment-1");
const roundTrip = (a: ClaimArtifact) => JSON.parse(JSON.stringify(a)) as ClaimArtifact; // a proof is a file: it must survive being written and read
const fails = (p: Promise<unknown>) => assert.rejects(p);

// An independent attester, run in this process: it checks the fact itself (here against stand-in sources) and signs only what is true.
const ATT_SECRET = "cd".repeat(32);
let attServer: Server | undefined;
let attKey = "";
const sources: AttesterSources = {
  readBalances: async () => [{ usd: true, amount: 5_000 }],
  inquiry: async () => ({ status: "approved", note: "" }),
  now: () => Date.now(),
};
async function startAttester(): Promise<string> {
  const { attesterKey } = await import("../lib/zk-attester");
  attKey = (await attesterKey(ATT_SECRET)).toPublicKey().toBase58();
  attServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      // No keep-alive: a pooled socket from an earlier test's attester must never carry this test's request.
      const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== "Bearer attester-token-0123456789") return send(401, { error: "no" });
      try { send(200, await attest(JSON.parse(raw), ATT_SECRET, sources)); } catch (e) { send(422, { error: (e as Error).message }); }
    });
  });
  // A fresh port each time (the OS picks one), so no request can reach a previous test's server.
  await new Promise<void>((ok) => attServer!.listen(0, "127.0.0.1", ok));
  const port = (attServer.address() as AddressInfo).port;
  process.env.ZK_ATTESTERS = `http://127.0.0.1:${port}|attester-token-0123456789|${attKey}`;
  process.env.ZK_ATTEST_THRESHOLD = "2";
  return attKey;
}
const stopAttester = () => { attServer?.close(); attServer?.closeAllConnections(); attServer = undefined; delete process.env.ZK_ATTESTERS; delete process.env.ZK_ATTEST_THRESHOLD; };
after(() => stopAttester());

beforeEach(() => { install(); seed(); stopAttester(); sources.inquiry = async () => ({ status: "approved", note: "" }); sources.readBalances = async () => [{ usd: true, amount: 5_000 }]; });

test("the committed claim verification keys are the circuits'", T, async () => {
  const committed = JSON.parse(readFileSync(CLAIMS_VK_FILE, "utf8")) as Record<string, { hash: string }>;
  for (const kind of ["sanctions", "name", "vendor", "solvency", "circuit"] as const) assert.equal((await compileClaim(kind)).hash, committed[kind].hash, `${kind} keys are stale: run npm run zk:claims:vk`);
});

// ---------- 1. Sanctions clearance ----------
test("sanctions: a clean payee gets a proof that reveals neither the payee nor anything but the list's root", T, async () => {
  const p = await prepareSanctions(CLEAN, subject, idx());
  const art = roundTrip(await proveClaim(p));
  const v = await verifyClaim(art, { listRoots: [String(p.public.listRoot)], subject });
  assert.equal(v.valid, true, v.problems.join());
  const everything = JSON.stringify(art);
  assert.ok(!everything.includes(CLEAN) && !everything.includes(String(addressLeaf(CLEAN))), "the payee is nowhere in the proof file");
  assert.equal(await payeeCommitment(CLEAN, String(p.private.salt)), v.statement.itemCommitment);
  assert.notEqual(await payeeCommitment("0x1111111111111111111111111111111111111111", String(p.private.salt)), v.statement.itemCommitment);
});

test("sanctions: no proof can be made for a listed payee, and a proof does not stretch to another list or subject", T, async () => {
  await assert.rejects(prepareSanctions(LISTED[3], subject, idx()), /on the OFAC list/);
  const p = await prepareSanctions(CLEAN, subject, idx());
  await fails(proveClaim({ ...p, private: { ...p.private, item: String(addressLeaf(LISTED[3])) } }));
  const good = await proveClaim(p);
  assert.equal((await verifyClaim(good, { listRoots: ["123"] })).valid, false, "a different list root");
  assert.equal((await verifyClaim(good, { subject: subjectOf("payment-2") })).valid, false, "a different payment");
  const tampered = roundTrip(good);
  tampered.proof.publicInput[0] = "1";
  assert.equal((await verifyClaim(tampered)).valid, false, "o1js rejects a changed statement");
});

test("the gaps between listed items cover everything else, with no overlap", () => {
  for (const { sorted, gaps } of [listGaps(idx()), nameGaps(idx())]) {
    assert.equal(gaps.length, sorted.length + 1);
    gaps.forEach(([lo, hi], i) => { assert.ok(lo < hi); if (i) assert.equal(lo, gaps[i - 1][1]); });
  }
});

// ---------- 2. Name clearance ----------
test("name: a vendor name not on the list is proved clear without revealing the name; a listed name or alias cannot be", T, async () => {
  const p = await prepareName("Brightline Design Studio", subject, idx());
  const art = roundTrip(await proveClaim(p));
  const v = await verifyClaim(art, { listRoots: [String(p.public.listRoot)], subject });
  assert.equal(v.valid, true, v.problems.join());
  assert.ok(!JSON.stringify(art).toLowerCase().includes("brightline"), "the name is nowhere in the proof file");
  assert.equal(await nameCommitment("BRIGHTLINE design studio, Ltd.", String(p.private.salt)), v.statement.itemCommitment, "the same name, normalised, opens the commitment");
  assert.notEqual(await nameCommitment("Other Studio", String(p.private.salt)), v.statement.itemCommitment);

  await assert.rejects(prepareName("Shadow Exchange", subject, idx()), /on the OFAC list/);
  await assert.rejects(prepareName("Night Harbor Imports Ltd.", subject, idx()), /on the OFAC list/, "an alias, in any case or company form");
  await fails(proveClaim({ ...p, private: { ...p.private, item: String((await import("../lib/zk-claims")).nameLeaf("shadow exchange")) } }));
  assert.equal((await verifyClaim(art, { listRoots: ["1"] })).valid, false);
  await assert.rejects(prepareName("ab", subject, idx()), /too short/);
});

test("name: only an exact normalised match is covered, and the limit is real: a near miss is not stopped here", T, async () => {
  // One letter off a listed name is a different string, so this proof exists. The ordinary screening (lib/sanctions.ts) still warns on near matches.
  const p = await prepareName("Shadow Exchenge", subject, idx());
  assert.ok(p.public.itemCommitment);
});

// ---------- 3. Verified credential, attested by k of n ----------
test("credential: with only this app as issuer, a verified vendor's proof says one issuer signed and does not say which vendor", T, async () => {
  const v = state().vendors[0];
  await assert.rejects(prepareCredential("vendor", v.name, subject), /not passed verification/);
  v.kyb = { status: "verified", inquiryId: "inq_1", updatedAt: new Date().toISOString() };
  const art = roundTrip(await proveClaim(await prepareCredential("vendor", v.name, subject)));
  const own = await issuerPublicKey();
  const ok = await verifyClaim(art, { trustedIssuers: [own], subject });
  assert.equal(ok.valid, true, ok.problems.join());
  assert.equal(ok.threshold, 1);
  assert.deepEqual([...new Set(ok.issuers)], [own]);
  assert.ok(!JSON.stringify(art).includes(v.name));
  assert.equal((await verifyClaim(art, { trustedIssuers: ["B62qkcAUaC8vTUTTUdSTQ5L7QGWHSqUfx4Lw8S7mTn1G9owGq5eJbPD"] })).valid, false, "an issuer the verifier does not trust");
  assert.equal((await verifyClaim(art, { minThreshold: 2 })).valid, false, "a verifier that wants two issuers is not satisfied by one");
  assert.equal((await verifyClaim({ ...art, kind: "business" })).valid, false, "a vendor credential is not a business credential");
});

test("credential: it cannot be forged or used after it expires; a business can hold one too", T, async () => {
  const v = state().vendors[0];
  v.kyb = { status: "verified", inquiryId: "inq_1", updatedAt: new Date().toISOString() };
  const p = await prepareCredential("vendor", v.name, subject);
  await fails(proveClaim({ ...p, private: { ...p.private, subjectId: "12345" } }));
  await fails(proveClaim({ ...p, public: { ...p.public, asOf: Number(p.private.validUntil) + 1 } }));
  const b = createBusiness("Cred Test Ltd", "owner@cred.test");
  setBusinessKyb(b.id, { status: "verified", inquiryId: "inq_9", updatedAt: new Date().toISOString() });
  const art = await proveClaim(await runAs(b.id, () => prepareCredential("business", undefined, subject)));
  assert.equal((await verifyClaim(art, { trustedIssuers: [await issuerPublicKey()] })).valid, true);
});

test("credential: two independent issuers must agree, and one key cannot pass for two", T, async () => {
  const v = state().vendors[0];
  v.kyb = { status: "verified", inquiryId: "inq_1", updatedAt: new Date().toISOString() };
  const att = await startAttester();
  sources.inquiry = async () => ({ status: "approved", note: `bluvfi:default:vendor:${v.name}` });
  const p = await prepareCredential("vendor", v.name, subject);
  const own = await issuerPublicKey();
  const art = roundTrip(await proveClaim(p));
  const ok = await verifyClaim(art, { trustedIssuers: [own, att], minThreshold: 2, subject });
  assert.equal(ok.valid, true, ok.problems.join());
  assert.deepEqual([ok.threshold, new Set(ok.issuers).size], [2, 2]);

  // Forge it: the attester's slot is filled with the app's own signature, so only one distinct issuer has signed.
  const sigs = p.private.signatures as string[];
  await fails(proveClaim({ ...p, private: { ...p.private, signatures: [sigs[0], sigs[0], sigs[0]] } }));
  // Listing the app's key twice does not make two issuers.
  await fails(proveClaim({ ...p, public: { ...p.public, issuers: [own, own, own] } }));
});

test("credential: if the second issuer is down, or will not sign what it cannot confirm, no proof is made", T, async () => {
  const v = state().vendors[0];
  v.kyb = { status: "verified", inquiryId: "inq_1", updatedAt: new Date().toISOString() };
  await startAttester();
  sources.inquiry = async () => ({ status: "declined", note: `bluvfi:default:vendor:${v.name}` });
  await assert.rejects(prepareCredential("vendor", v.name, subject), /2 issuers must sign but only 1 did/);
  sources.inquiry = async () => ({ status: "approved", note: "bluvfi:default:vendor:Someone Else" });
  await assert.rejects(prepareCredential("vendor", v.name, subject), /2 issuers must sign but only 1 did/, "a verification made for a different vendor");
  stopAttester();
  process.env.ZK_ATTESTERS = `http://127.0.0.1:1|x|${attKey}`;
  process.env.ZK_ATTEST_THRESHOLD = "2";
  await assert.rejects(prepareCredential("vendor", v.name, subject), /only 1 did/);
});

// ---------- 4. Solvency, attested by k of n ----------
test("solvency: a signed balance snapshot proves 'at least $X' without revealing any balance", T, async () => {
  services.treasuryBalances = async () => [{ chain: "near", asset: "USDC", amount: 5_000.25, usd: true }, { chain: "near", asset: "NEAR", amount: 900, usd: false }];
  const art = roundTrip(await proveClaim(await prepareSolvency(4_000, subject)));
  const v = await verifyClaim(art, { trustedIssuers: [await issuerPublicKey()], subject });
  assert.equal(v.valid, true, v.problems.join());
  assert.equal(v.statement.minTotalCents, "400000");
  assert.ok(!JSON.stringify(art).includes("500025"), "the balance is nowhere in the proof file");
});

test("solvency: it cannot claim more than the snapshot holds, cannot change the balances, and a stale snapshot is refused", T, async () => {
  services.treasuryBalances = async () => [{ chain: "near", asset: "USDC", amount: 5_000, usd: true }];
  await fails(proveClaim(await prepareSolvency(6_000, subject)));
  const p = await prepareSolvency(1_000, subject);
  await fails(proveClaim({ ...p, private: { ...p.private, balances: [10_000_00, 0, 0, 0, 0, 0, 0, 0] } }));
  await fails(proveClaim({ ...p, public: { ...p.public, asOf: Number(p.public.asOf) + 2 * 86_400 } }));
  services.treasuryBalances = async () => [{ chain: "near", asset: "NEAR", amount: 10, usd: false }];
  await assert.rejects(prepareSolvency(1, subject), /No balances/);
});

test("solvency: a second issuer reads the chain itself and will not sign a figure above what it sees", T, async () => {
  const att = await startAttester();
  services.treasuryBalances = async () => [{ chain: "near", asset: "USDC", amount: 5_000, usd: true }];
  const art = await proveClaim(await prepareSolvency(4_000, subject));
  const v = await verifyClaim(art, { trustedIssuers: [await issuerPublicKey(), att], minThreshold: 2 });
  assert.equal(v.valid, true, v.problems.join());
  // The app (or someone who has taken its key) reports more than the chain holds: the attester refuses.
  services.treasuryBalances = async () => [{ chain: "near", asset: "USDC", amount: 50_000, usd: true }];
  await assert.rejects(prepareSolvency(40_000, subject), /2 issuers must sign but only 1 did/);
});

test("attester: it refuses bad requests, stale snapshots and mismatched commitments", T, async () => {
  const ok = { kind: "solvency" as const, account: "x.near", balances: [100, 0, 0, 0, 0, 0, 0, 0], salt: "5", takenAt: Math.floor(Date.now() / 1000), commitment: "1" };
  await assert.rejects(attest({ ...ok }, ATT_SECRET, sources), /commitment does not match/);
  await assert.rejects(attest({ kind: "solvency", account: "x.near" }, ATT_SECRET, sources), /Incomplete/);
  await assert.rejects(attest({ ...ok, takenAt: ok.takenAt - 3600 }, ATT_SECRET, sources), /not from now/);
  await assert.rejects(attest({ kind: "vendor" } as never, ATT_SECRET, sources), /Incomplete credential/);
  await assert.rejects(attest({ kind: "other" } as never, ATT_SECRET, sources), /Unknown kind/);
  await assert.rejects(attest({ kind: "solvency" }, "short"), /64 hex/);
});

// ---------- 5. Resources of a secret circuit, any length ----------
const CIRCUIT = [
  { kind: 1 as const, a: 0 }, { kind: 2 as const, a: 0, b: 1 }, { kind: 3 as const, a: 0, b: 1, c: 2 },
  { kind: 3 as const, a: 1, b: 2, c: 3 }, { kind: 2 as const, a: 3, b: 4 }, { kind: 3 as const, a: 4, b: 2, c: 0 },
]; // 5 qubits (0..4), 3 Toffoli gates
/** A longer circuit: the small one repeated, so it spans several chunks, with a known count (3 Toffoli and 5 qubits per repeat's worth of use). */
const LONG = Array.from({ length: 7 }, () => CIRCUIT).flat(); // 42 gates: 2 chunks of 32, 21 Toffoli, 5 qubits

test("circuit: a hidden circuit's bounds are proved without revealing a single gate", T, async () => {
  const p = await prepareCircuit(CIRCUIT, 5, 3, subject);
  const art = roundTrip(await proveClaim(p));
  const v = await verifyClaim(art, { subject });
  assert.equal(v.valid, true, v.problems.join());
  assert.deepEqual([v.statement.maxQubits, v.statement.maxToffoli], ["5", "3"]);
  const wire = JSON.stringify(art);
  assert.ok(!wire.includes('"gates"') && !wire.includes(String(p.private.salt)), "no gate, and no salt, in the proof file");
  assert.notEqual((await prepareCircuit(CIRCUIT.slice(0, 5), 5, 3, subject)).public.circuitCommitment, p.public.circuitCommitment, "the commitment pins the exact circuit");
});

test("circuit: a circuit longer than one proof is proved a chunk at a time by recursion, and the bounds still bind", T, async () => {
  const p = await prepareCircuit(LONG, 5, 21, subject);
  assert.equal((p.private.gates as unknown[]).length, 64, "42 gates padded to two chunks");
  const art = roundTrip(await proveClaim(p));
  assert.equal((await verifyClaim(art, { subject })).valid, true);
  await fails(proveClaim(await prepareCircuit(LONG, 5, 20, subject))); // 21 Toffoli gates across both chunks, against a bound of 20
  await fails(proveClaim(await prepareCircuit(LONG, 4, 21, subject)));
  // Gates from the second chunk cannot be dropped or reordered without breaking the commitment.
  const swapped = { ...p, private: { ...p.private, gates: [...(p.private.gates as unknown[]).slice(32), ...(p.private.gates as unknown[]).slice(0, 32)] } };
  await fails(proveClaim(swapped));
  await assert.rejects(prepareCircuit(Array.from({ length: MAX_TOTAL_GATES + 1 }, () => ({ kind: 1 as const, a: 0 })), 9, 9, subject), new RegExp(`up to ${MAX_TOTAL_GATES} gates`));
  await assert.rejects(prepareCircuit([], 9, 9, subject), /no gates/);
});

test("circuit: a bound the circuit breaks, an impossible gate and a swapped circuit cannot be proved", T, async () => {
  await fails(proveClaim(await prepareCircuit(CIRCUIT, 5, 2, subject)));
  await fails(proveClaim(await prepareCircuit(CIRCUIT, 4, 3, subject)));
  await fails(proveClaim(await prepareCircuit([{ kind: 3, a: 0, b: 0, c: 1 }], 9, 9, subject)));
  const p = await prepareCircuit(CIRCUIT, 5, 3, subject);
  const swapped = { ...p, private: { ...p.private, gates: (p.private.gates as unknown[]).map((g, i) => (i === 0 ? { kind: 1, a: 0, b: 0, c: 0 } : g)).reverse() } };
  await fails(proveClaim(swapped));
});

// ---------- The app around the proofs ----------
test("a claim job: the private part is sealed while waiting, the proof file holds only public facts, and the private part is gone after", T, async () => {
  process.env.BLUVFI_ZK_NO_SPAWN = "1";
  const { startClaim, runClaimJob, claimsFor, claimById } = await import("../lib/zk-claims");
  const { readFileSync: read, existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ZK_DIR } = await import("../lib/zk");
  const p = await prepareSanctions(CLEAN, subject, idx());
  const rec = await startClaim(p);
  assert.equal(rec.status, "proving");
  const jobs = join(ZK_DIR, "claims", "jobs");
  const sealed = read(join(jobs, `${rec.id}.sealed`), "utf8");
  assert.match(sealed, /^bluvfi-sealed-v1:/);
  assert.ok(!sealed.includes(String(p.private.item)), "the payee is not readable while the job waits");
  await runClaimJob(rec.id);
  const done = claimById(rec.id, rec.biz)!;
  assert.equal(done.status, "done");
  assert.ok(!existsSync(join(jobs, `${rec.id}.sealed`)), "the private data is deleted once the proof exists");
  assert.ok(!read(join(ZK_DIR, "claims", `${rec.id}.json`), "utf8").includes(String(p.private.item)));
  assert.equal(claimsFor(rec.biz).some((c) => c.id === rec.id), true);
  assert.equal(claimById(rec.id, "bz_someoneelse"), undefined, "another business cannot see it");
  assert.equal(readdirSync(jobs).includes(`${rec.id}.sealed`), false);
});

test("the public verify route: a good proof is valid and says who issued it and how many had to sign; a changed one is not", T, async () => {
  const { POST } = await import("../app/api/claims/verify/route");
  const v = state().vendors[0];
  v.kyb = { status: "verified", inquiryId: "inq_1", updatedAt: new Date().toISOString() };
  const art = await proveClaim(await prepareCredential("vendor", v.name, subject));
  const call = (a: unknown, expect?: unknown) => POST(new Request("https://x.example/api/claims/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact: a, expect }) }), undefined) as Promise<Response>;
  const good = (await (await call(art)).json()) as { valid: boolean; issuerIsThisApp: boolean; kind: string; threshold: number; distinctIssuers: number };
  assert.deepEqual([good.valid, good.issuerIsThisApp, good.kind, good.threshold, good.distinctIssuers], [true, true, "vendor", 1, 1]);
  // What the person checking requires: an issuer they trust, and how many different ones must have signed.
  const own = await issuerPublicKey();
  assert.equal(((await (await call(art, { trustedIssuer: own, minThreshold: 1 })).json()) as { valid: boolean }).valid, true);
  assert.equal(((await (await call(art, { trustedIssuer: "B62qkcAUaC8vTUTTUdSTQ5L7QGWHSqUfx4Lw8S7mTn1G9owGq5eJbPD" })).json()) as { valid: boolean }).valid, false, "an issuer they do not trust");
  assert.equal(((await (await call(art, { minThreshold: 2 })).json()) as { valid: boolean }).valid, false, "they want two issuers");
  const bad = roundTrip(art);
  bad.proof.publicInput[10] = "1"; // a different "as of" time
  assert.equal(((await (await call(bad)).json()) as { valid: boolean }).valid, false);
  assert.equal((await call({ nonsense: true })).status, 400);
});
