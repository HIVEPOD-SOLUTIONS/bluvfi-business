// A stand-in for another instance of the app: it adds 1 to a shared counter file N times, each time under the shared lock,
// with a pause between reading and writing (as a payout or an AI review would leave). Run by tests/shared-file.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { exclusive, writeAtomic } from "../../lib/shared-file";

const [file, times] = [process.argv[2], Number(process.argv[3])];

async function main() {
  for (let i = 0; i < times; i++) {
    await exclusive("counter", file, async () => {
      const n = existsSync(file) ? Number(JSON.parse(readFileSync(file, "utf8")).n) : 0;
      await new Promise((r) => setTimeout(r, Math.random() * 4));
      writeAtomic(file, JSON.stringify({ n: n + 1 }));
    });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
