import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Files that several copies of the app share. Run as many instances as you like, as long as they mount the same .data
 * folder (a Docker volume, a Kubernetes ReadWriteMany volume, EFS or NFS): every write happens under a lock that all of
 * them respect, and each instance re-reads a file when another one has changed it.
 *
 * The lock is a directory made next to the file (`<file>.lock`): making a directory is atomic on every filesystem,
 * shared ones included. A lock whose holder died is taken over once it has not been refreshed for STALE_MS; a holder
 * doing slow work (a payout, an AI review) refreshes it every few seconds so it is never taken from under it.
 */
const STALE_MS = Number(process.env.BLUVFI_LOCK_STALE_MS ?? 60_000);
const WAIT_MS = Number(process.env.BLUVFI_LOCK_WAIT_MS ?? 120_000);

/** Changes whenever the file is replaced (each write is a rename, so a new inode) or edited. "" when there is no file. */
export function fileStamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Write a file so a reader in any instance sees the old or the new content, never half of one. */
export function writeAtomic(file: string, text: string | Buffer, mode?: number) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof text === "string" ? Buffer.from(text, "utf8") : text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

const lockDir = (file: string) => `${file}.lock`;

/** One try at the lock: true if we now hold it. A lock left by a dead holder is cleared and retried once. */
function tryLock(file: string): boolean {
  const dir = lockDir(file);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      return true;
    }
  } catch {
    /* someone else took it first */
  }
  return false;
}

const unlock = (file: string) => rmSync(lockDir(file), { recursive: true, force: true });
const busy = (file: string) => new Error(`The records in ${file} are busy (another request has held them for over ${Math.round(WAIT_MS / 1000)} s). Try again.`);

/** For quick synchronous read-change-write steps (a registry entry, an index line). */
export function withFileLockSync<T>(file: string, fn: () => T, waitMs = WAIT_MS): T {
  const until = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!tryLock(file)) {
    if (Date.now() > until) throw busy(file);
    Atomics.wait(nap, 0, 0, 15);
  }
  try {
    return fn();
  } finally {
    unlock(file);
  }
}

// ---------- Exclusive work on one business's records, in this process and across instances ----------

const held = new AsyncLocalStorage<Set<string>>();
const g = globalThis as unknown as { __bluvfiQueues?: Map<string, Promise<void>> };
const queues = () => (g.__bluvfiQueues ??= new Map());

/**
 * Run `fn` while no other request, in this process or another instance, works on the same records. Requests for the same
 * key wait their turn; nested calls for a key already held in this async context run straight away. `file` is the file the
 * records live in (none in tests and the CLI demo, which keep nothing on disk: then only this process is serialised).
 */
export async function exclusive<T>(key: string, file: string, fn: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(key)) return fn();
  const q = queues();
  const before = q.get(key) ?? Promise.resolve();
  let done!: () => void;
  const turn = new Promise<void>((r) => (done = r));
  const tail = before.then(() => turn);
  q.set(key, tail);
  let beat: ReturnType<typeof setInterval> | undefined;
  let locked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const until = Date.now() + waitMs;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(busy(file || key)), waitMs);
    });
    try {
      await Promise.race([before, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (file) {
      while (!tryLock(file)) {
        if (Date.now() > until) throw busy(file);
        await new Promise((r) => setTimeout(r, 25));
      }
      locked = true;
      // Keep the lock fresh while slow work runs, so no other instance mistakes it for a dead one.
      beat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(lockDir(file), now, now);
        } catch {
          /* the lock went away: nothing to refresh */
        }
      }, Math.max(1000, STALE_MS / 4));
      beat.unref?.();
    }
    return await held.run(new Set([...(mine ?? []), key]), fn);
  } finally {
    if (beat) clearInterval(beat);
    if (locked) unlock(file);
    done();
    if (q.get(key) === tail) q.delete(key);
  }
}
