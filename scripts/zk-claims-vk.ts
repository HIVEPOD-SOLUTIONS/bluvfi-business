/**
 * `npm run zk:claims:vk`: compile the zero-knowledge claim circuits (lib/zk-claims-program.ts) and write their verification keys to
 * zk/claims-verification-keys.json. Run it after changing a circuit; tests/zk-claims.test.ts fails if the committed keys are stale.
 */
async function main() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { compileClaim, CLAIMS_VK_FILE } = await import("../lib/zk-claims");
  const out: Record<string, { data: string; hash: string }> = {};
  for (const kind of ["sanctions", "name", "vendor", "solvency", "circuit"] as const) {
    const t0 = Date.now();
    out[kind] = await compileClaim(kind);
    console.log(`${kind}: ${out[kind].hash} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  mkdirSync("zk", { recursive: true });
  writeFileSync(CLAIMS_VK_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`Verification keys written to ${CLAIMS_VK_FILE}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
