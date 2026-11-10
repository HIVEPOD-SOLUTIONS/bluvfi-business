/**
 * `npm run demo`: the whole flow in about ten seconds, with no keys, no funds and no network.
 * Three fictional invoices go through the real pipeline (lib/agent.ts); only the outside services are
 * fixtures (lib/demo.ts). Signatures, request/response binding, policy, fraud checks and the post-quantum
 * record signature are all checked for real.
 */
process.env.BLUVFI_DEMO = "1";
process.env.BLUVFI_PERSIST = "0";

async function main() {
  const { runDemo } = await import("../lib/demo-scenario");
  const { state } = await import("../lib/store");
  const { ed25519Verify } = await import("../lib/crypto");

  const t0 = Date.now();
  console.log("Bluvfi Business demo: an AI agent pays invoices. One of them is a scam written to trick the AI.\n");
  const r = await runDemo({ vendorReplies: true, log: (l) => console.log(l) });

  const p = r.fraud;
  const v = p.verified;
  const tick = (ok: boolean) => (ok ? "✓" : "✕");
  console.log("\nVerified panel for invoice 2 (AL-2207):");
  for (const c of p.checks) console.log(`  ${c.verdict === "allow" ? "✓" : c.verdict === "warn" ? "!" : "✕"} ${c.label}: ${c.reason}`);
  console.log(`  ${tick(v.signature.valid)} Model signature (ed25519) by ${v.signature.signingAddress.slice(0, 16)}…, request bound ${tick(v.signature.requestBound)}, response bound ${tick(v.signature.responseBound)}`);
  console.log(`  ${tick(v.attestation.cpu && v.attestation.gpu)} Hardware attestation: ${v.attestation.source === "demo-fixture" ? "not claimed (demo fixture, see note)" : v.attestation.cpu && v.attestation.gpu ? "Intel TDX + NVIDIA verified" : "not verified"}`);
  console.log(`  ${tick(v.pqSignature.valid)} Record signed with ML-DSA-65 (post-quantum)`);
  console.log(`  Policy v${v.policyVersion} ${v.policyHash.slice(0, 16)}…  record ${p.recordHash.slice(0, 16)}…  previous ${p.prevHash.slice(0, 16)}…`);
  for (const n of v.attestation.notes) console.log(`  note: ${n}`);

  // Re-check the model signature here, independently of the app's own verifier.
  const again = ed25519Verify(v.signature.signature, v.signature.text, v.signature.signingAddress);
  console.log(`\nIndependent re-check of the ed25519 signature: ${again ? "valid" : "INVALID"}`);

  // --zk: prove the scam invoice's policy check with o1js and verify it (about 30 s the first time, then ~15 s).
  if (process.argv.includes("--zk")) {
    const { proveJob, verifyZk, writeJob } = await import("../lib/zk");
    console.log("\nProving the policy check for AL-2207 with o1js (zero-knowledge, no trusted hardware)…");
    writeJob(p.id, p.zkJob!);
    const seconds = await proveJob(p.id, p.zkJob!);
    const z = await verifyZk(p.id, p.zkJob!);
    console.log(`  ${tick(z.status === "verified")} Proved in ${seconds}s. ${z.note}`);
    if (z.status !== "verified") process.exit(1);
  }

  const s = state();
  console.log(`\nShared blocklist now has ${s.blocklist.length} entr${s.blocklist.length === 1 ? "y" : "ies"}: ${s.blocklist.map((b) => b.value).join(", ")}`);
  console.log(`Stopped before paying: $${[r.fraud, r.lookalike].filter((x) => x.status === "blocked" || x.status === "cancelled").reduce((a, x) => a + x.invoice.amountUsd, 0).toLocaleString()}`);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Open the same story in the web app with: npm run demo:ui`);

  const ok =
    r.normal.status === "paid" && r.fraud.status === "cancelled" && r.lookalike.status === "blocked" && r.check.verdict === "block" &&
    [r.normal, r.fraud, r.lookalike].every((x) => x.verified.signature.valid && x.verified.pqSignature.valid) && again &&
    // The attacks: none may be paid or even cleared, including the two where the AI was fooled into saying pay.
    r.attacks.map((x) => x.status).join(",") === "blocked,blocked,held" && r.attacks[1].ai.decision === "pay" && r.attacks[2].ai.decision === "pay";
  if (!ok) {
    console.error("\nDEMO FAILED: an outcome or a signature was not what the story expects.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
