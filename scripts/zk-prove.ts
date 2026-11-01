/**
 * `npm run zk:prove [payment id ...]`: prove policy-check statements with o1js.
 *   with ids   prove those payments
 *   no ids     prove every job in .data/zk/jobs without a proof, and keep going until none is left. The app starts
 *              this in the background after each payment; a lock file keeps it to one prover at a time.
 */
async function main() {
  const { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { proveJob, ZK_DIR } = await import("../lib/zk");
  const prove = async (id: string) => {
    const seconds = await proveJob(id, JSON.parse(readFileSync(join(ZK_DIR, "jobs", `${id}.json`), "utf8")));
    console.log(`${id}: proved in ${seconds}s`);
  };

  const ids = process.argv.slice(2);
  if (ids.length) {
    for (const id of ids) await prove(id);
    process.exit(0);
  }

  const lock = join(ZK_DIR, "proving.lock");
  mkdirSync(ZK_DIR, { recursive: true });
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 10 * 60_000) process.exit(0); // another prover is on it
  writeFileSync(lock, String(process.pid));
  try {
    const pending = () =>
      existsSync(join(ZK_DIR, "jobs"))
        ? readdirSync(join(ZK_DIR, "jobs")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).filter((id) => !existsSync(join(ZK_DIR, "proofs", `${id}.json`)))
        : [];
    for (let next = pending(); next.length; next = pending()) {
      for (const id of next) {
        writeFileSync(lock, String(process.pid)); // still alive
        await prove(id);
      }
    }
  } finally {
    rmSync(lock, { force: true });
  }
  process.exit(0); // o1js keeps worker threads alive
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
