import "./setup";
import "../setup-zk";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

// Zero-knowledge claims on REAL data: the real OFAC list (every listed crypto address, and every listed name and alias, as Merkle trees),
// a real mainnet treasury's USDC balance read from the chain by two independent issuers, and a circuit too long for one proof. The proofs are
// real o1js proofs. Run after the Layer 1 setup so the treasury below is the one read.
process.env.TREASURY_ACCOUNT = "intents.near"; // a real, large USDC holder on NEAR mainnet
const T = { timeout: 1_800_000 };

test("a real OFAC address clearance: the whole list becomes one root, a clean payee is proved clear, a listed one cannot be", T, async () => {
  const { loadSanctions } = await import("../../lib/sanctions");
  const { prepareSanctions, proveClaim, verifyClaim, subjectOf, listGaps } = await import("../../lib/zk-claims");
  const idx = await loadSanctions(true);
  assert.ok(idx, "the real list loaded");
  const { sorted } = listGaps(idx);
  assert.ok(sorted.length > 300, `${sorted.length} listed addresses are in the tree`);

  const subject = subjectOf("real-payment");
  const p = await prepareSanctions("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", subject, idx);
  const art = await proveClaim(p);
  const v = await verifyClaim(art, { listRoots: [String(p.public.listRoot)], subject });
  assert.equal(v.valid, true, v.problems.join());
  assert.match(art.label, new RegExp(`OFAC list dated ${idx.listDate}`));
  await assert.rejects(prepareSanctions("0x098B716B8Aaf21512996dC57EB0615e2383E2f96", subject, idx), /on the OFAC list/);
});

test("a real OFAC name clearance: every listed name and alias becomes one root; an ordinary vendor is proved clear, a listed name cannot be", T, async () => {
  const { loadSanctions } = await import("../../lib/sanctions");
  const { prepareName, proveClaim, verifyClaim, subjectOf, nameGaps } = await import("../../lib/zk-claims");
  const idx = await loadSanctions();
  assert.ok(idx);
  const { sorted } = nameGaps(idx);
  assert.ok(sorted.length > 20_000, `${sorted.length} listed names and aliases are in the tree`);
  const subject = subjectOf("real-vendor");
  const t0 = Date.now();
  const p = await prepareName("Brightline Design Studio", subject, idx);
  console.log(`  (name tree of ${sorted.length} names built in ${Math.round((Date.now() - t0) / 1000)} s)`);
  const art = await proveClaim(p);
  const v = await verifyClaim(art, { listRoots: [String(p.public.listRoot)], subject });
  assert.equal(v.valid, true, v.problems.join());
  await assert.rejects(prepareName("Lazarus Group", subject, idx), /on the OFAC list/);
  await assert.rejects(prepareName("BANK MARKAZI JOMHOURI ISLAMI IRAN", subject, idx), /on the OFAC list/);
});

let attester: Server | undefined;
after(() => attester?.close());

test("a real solvency proof attested by two issuers: each reads the treasury's USDC balance off the chain itself, and the proof shows only 'at least $X'", T, async () => {
  const { services } = await import("../../lib/services");
  const { attest, attesterKey } = await import("../../lib/zk-attester"); // its sources are the real chain and the real Persona
  const { prepareSolvency, proveClaim, verifyClaim, issuerPublicKey, subjectOf } = await import("../../lib/zk-claims");
  const SECRET = "ee".repeat(32);
  const attKey = (await attesterKey(SECRET)).toPublicKey().toBase58();
  attester = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      try { send(200, await attest(JSON.parse(raw), SECRET)); } catch (e) { send(422, { error: (e as Error).message }); }
    });
  });
  await new Promise<void>((ok) => attester!.listen(47872, "127.0.0.1", ok));
  process.env.ZK_ATTESTERS = `http://127.0.0.1:47872|real-attester-token-0123|${attKey}`;
  process.env.ZK_ATTEST_THRESHOLD = "2";

  const usdc = (await services.treasuryBalances()).find((b) => b.usd)!;
  assert.ok(usdc.amount > 1_000, `the real balance is ${usdc.amount} USDC`);
  const subject = subjectOf("real-solvency");
  const art = await proveClaim(await prepareSolvency(1_000, subject));
  const v = await verifyClaim(art, { trustedIssuers: [await issuerPublicKey(), attKey], minThreshold: 2, subject });
  assert.equal(v.valid, true, v.problems.join());
  assert.equal(v.threshold, 2);
  assert.equal(new Set(v.issuers).size, 2, "two different issuers signed");
  assert.ok(!JSON.stringify(art).includes(String(Math.round(usdc.amount * 100))), "the balance is not in the proof");
  await assert.rejects(proveClaim(await prepareSolvency(Math.ceil(usdc.amount) * 10, subject)));
  delete process.env.ZK_ATTESTERS;
  delete process.env.ZK_ATTEST_THRESHOLD;
});

test("a circuit too long for one proof (100 gates, four chunks) is bounded by recursion", T, async () => {
  const { prepareCircuit, proveClaim, verifyClaim, subjectOf } = await import("../../lib/zk-claims");
  // A ripple of Toffoli and CNOT gates over 12 qubits: 100 gates, of which 50 are Toffoli, using qubits 0..11.
  const gates = Array.from({ length: 100 }, (_, i) => (i % 2 ? { kind: 2 as const, a: i % 12, b: (i + 1) % 12 } : { kind: 3 as const, a: i % 12, b: (i + 1) % 12, c: (i + 2) % 12 }));
  const subject = subjectOf("real-circuit");
  const p = await prepareCircuit(gates, 12, 50, subject);
  assert.equal((p.private.gates as unknown[]).length, 128, "padded to four chunks of 32");
  const art = await proveClaim(p);
  const v = await verifyClaim(art, { subject });
  assert.equal(v.valid, true, v.problems.join());
  await assert.rejects(proveClaim(await prepareCircuit(gates, 12, 49, subject)));
  await assert.rejects(proveClaim(await prepareCircuit(gates, 11, 50, subject)));
});
