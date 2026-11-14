import { DIR } from "./setup-vault";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertLockHeld, exclusive, withFileLockSync, writeAtomic } from "../lib/shared-file";
import { refreshState, resetAllState, state, withRecords } from "../lib/store";
import { runAs } from "../lib/tenant";
import { sealText } from "../lib/vault";
import type { Vendor } from "../lib/types";

const worker = (file: string, times: number) =>
  new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", join("tests", "helpers", "counter-worker.ts"), file, String(times)], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
  });

test("several instances writing one file through the lock lose no update", async () => {
  const file = join(DIR, "counter.json");
  const codes = await Promise.all([worker(file, 25), worker(file, 25), worker(file, 25)]);
  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).n, 75);
  assert.ok(!existsSync(`${file}.lock`), "the lock is released");
});

test("work on the same records waits its turn in this process; nested work on records already held runs straight away", async () => {
  const file = join(DIR, "turns.json");
  const log: string[] = [];
  const job = (name: string) =>
    exclusive("turns", file, async () => {
      log.push(`${name} in`);
      await new Promise((r) => setTimeout(r, 15));
      await exclusive("turns", file, async () => log.push(`${name} nested`));
      log.push(`${name} out`);
    });
  await Promise.all([job("a"), job("b")]);
  assert.deepEqual(log, ["a in", "a nested", "a out", "b in", "b nested", "b out"]);
});

test("a lock left by a crashed instance is taken over once it goes stale; a busy one makes the caller wait, then give up", async () => {
  const file = join(DIR, "stale.json");
  mkdirSync(`${file}.lock`, { recursive: true });
  // Held and fresh: a caller that will not wait long is told the records are busy.
  await assert.rejects(exclusive("stale", file, async () => 1, 200), /busy/);
  assert.throws(() => withFileLockSync(file, () => 1, 100), /busy/);
  // Left behind long ago (no heartbeat): taken over.
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(await exclusive("stale", file, async () => 42), 42);
  assert.ok(!existsSync(`${file}.lock`));
});

test("a business's records written by another instance are read again before the next request uses them", async () => {
  resetAllState();
  await runAs("default", () => withRecords(() => void state().vendors.splice(0)));
  // Another instance adds a vendor and saves: same file, same master key.
  const theirs = { ...state(), vendors: [{ name: "Written Elsewhere Ltd" } as Vendor] };
  writeAtomic(join(DIR, "state.json"), sealText(JSON.stringify(theirs)));
  runAs("default", () => {
    refreshState();
    assert.deepEqual(state().vendors.map((v) => v.name), ["Written Elsewhere Ltd"]);
  });
  // And a write here starts from it rather than from the stale copy.
  await runAs("default", () => withRecords(() => void state().vendors.push({ name: "Written Here Ltd" } as Vendor)));
  resetAllState();
  runAs("default", () => assert.deepEqual(state().vendors.map((v) => v.name), ["Written Elsewhere Ltd", "Written Here Ltd"]));
});

test("two approvals of one thing at the same moment run one after the other, so the second sees the first's result", async () => {
  resetAllState();
  let issued = 0;
  const approve = () =>
    runAs("default", () =>
      withRecords(async () => {
        const s = state() as unknown as { probe?: string };
        if (s.probe === "done") return "already done";
        await new Promise((r) => setTimeout(r, 20)); // a provider call
        issued++;
        s.probe = "done";
        return "issued";
      }),
    );
  const results = await Promise.all([approve(), approve()]);
  assert.deepEqual(results.sort(), ["already done", "issued"]);
  assert.equal(issued, 1);
});

test("a holder whose lock was taken over (it stalled past the stale time) saves nothing and leaves the new holder's lock alone", async () => {
  const file = join(DIR, "taken.json");
  const lock = `${file}.lock`;
  await assert.rejects(
    exclusive("taken", file, async () => {
      // Another instance decided this lock was dead and took it: its own token is in the lock now.
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), "someone-else");
      assertLockHeld(file);
    }),
    /lost its hold on the records/,
  );
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), "someone-else", "the new holder keeps its lock");
  rmSync(lock, { recursive: true, force: true });
});
