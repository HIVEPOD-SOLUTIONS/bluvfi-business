/**
 * `npm run zk:vk`: compile the policy-check circuit (lib/zk-program.ts) and write its verification key to
 * zk/verification-key.json. Run it after changing the circuit; tests/zk.test.ts fails if the committed key is stale.
 */
async function main() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { compileProgram, VK_FILE } = await import("../lib/zk");
  const vk = await compileProgram();
  mkdirSync("zk", { recursive: true });
  writeFileSync(VK_FILE, JSON.stringify(vk, null, 2) + "\n");
  console.log(`Verification key ${vk.hash} written to ${VK_FILE}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
