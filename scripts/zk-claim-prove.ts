/**
 * Proves one zero-knowledge claim job (lib/zk-claims.ts). Started by the app with the job's id; reads the job's sealed private data, writes the
 * proof into the claim's record, and deletes the private data. Run: tsx scripts/zk-claim-prove.ts <claim id>
 */
async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("Usage: tsx scripts/zk-claim-prove.ts <claim id>");
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* only what the shell has */
  }
  const { runClaimJob } = await import("../lib/zk-claims");
  await runClaimJob(id);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
