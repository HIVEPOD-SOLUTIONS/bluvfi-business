/**
 * `npm run zk:verify`: check policy-check proofs with o1js against zk/verification-key.json.
 *   (default)  every payment in the app's state; the result is recorded on the payment
 *   --jobs     every job in .data/zk/jobs against its proof; exits non-zero if any is missing or invalid
 */
async function main() {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ZK_DIR, verifyZk } = await import("../lib/zk");

  if (process.argv.includes("--jobs")) {
    const dir = join(ZK_DIR, "jobs");
    let bad = 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      const r = await verifyZk(id, JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (r.status !== "verified") bad++;
      console.log(`${id}: ${r.status}: ${r.note}`);
    }
    console.log(`${files.length - bad} of ${files.length} proofs verified`);
    process.exit(bad || !files.length ? 1 : 0);
  }

  const { refreshZk } = await import("../lib/agent");
  const { state } = await import("../lib/store");
  const counts: Record<string, number> = {};
  for (const p of state().payments) {
    await refreshZk(p);
    const s = p.verified.zkProof?.status ?? "none";
    counts[s] = (counts[s] ?? 0) + 1;
    if (s !== "pending") console.log(`${p.invoice.invoiceNumber}: ${s}: ${p.verified.zkProof?.note}`);
  }
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "no payments");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
