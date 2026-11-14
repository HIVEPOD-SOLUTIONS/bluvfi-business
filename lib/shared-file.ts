import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Files that several copies of the app share. Run as many instances as you like, as long as they mount the same .data
 * folder (a Docker volume, a Kubernetes ReadWriteMany volume, EFS or NFS): every write happens under a lock that all of
 * them respect, and each instance re-reads a file when another one has changed it.
 *
 * The lock is a directory made next to the file (`<file>.lock`): making a directory is atomic on every filesystem,
 * shared ones included. A lock whose holder died is taken over once it has not been refreshed for STALE_MS; a holder
 * doing slow work (a payout, an AI review) refreshes it every few seconds so it is never taken from under it.
 *
 * Each lock carries its holder's random token. Only the holder removes it, and the records are saved only while the
 * token is still there: a holder that stalled long enough to lose its lock saves nothing and its request fails, instead
 * of overwriting what the next holder wrote.
 */
const STALE_MS = Number(process.env.BLUVFI_LOCK_STALE_MS ?? 60_000);
const WAIT_MS = Number(process.env.BLUVFI_LOCK_WAIT_MS ?? 120_000);
/** The synchronous locks guard steps of a few milliseconds and block the process while they wait, so they give up sooner. */
const SYNC_STALE_MS = Number(process.env.BLUVFI_SYNC_LOCK_STALE_MS ?? 5_000);
const SYNC_WAIT_MS = Number(process.env.BLUVFI_SYNC_LOCK_WAIT_MS ?? 10_000);

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
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  // On Windows a rename over a file fails for a moment while another program (antivirus, the search indexer, a reader)
  // has it open. Retry briefly, as graceful-fs does, instead of failing the write; on Linux this never triggers.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      try {
        const dfd = openSync(dirname(file), "r");
        try { fsyncSync(dfd); } finally { closeSync(dfd); }
      } catch {
        /* not supported here (Windows): the file itself was already synced */
      }
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const lockDir = (file: string) => `${file}.lock`;
const ownerFile = (file: string) => join(lockDir(file), "owner");
/** The token of whoever holds the lock now ("" when nobody does, or it is being made). */
function ownerOf(file: string): string {
  try {
    return readFileSync(ownerFile(file), "utf8");
  } catch {
    return "";
  }
}

/** One try at the lock: our token if we now hold it, null if not. A lock left by a dead holder is cleared and retried once. */
function tryLock(file: string, staleMs: number): string | null {
  const dir = lockDir(file);
  mkdirSync(dirname(dir), { recursive: true });
  const token = randomBytes(12).toString("hex");
  const claim = () => {
    mkdirSync(dir);
    writeFileSync(ownerFile(file), token);
    return token;
  };
  try {
    return claim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  try {
    if (Date.now() - statSync(dir).mtimeMs > staleMs) {
      // Move the dead lock aside under a name of our own: of several instances doing this at once, one rename wins.
      // If two still both end up "holding" it, the owner token decides: the one whose token is not there saves nothing.
      const aside = `${dir}.stale-${token}`;
      renameSync(dir, aside);
      rmSync(aside, { recursive: true, force: true });
      return claim();
    }
  } catch {
    /* someone else took it first */
  }
  return null;
}

/** Remove the lock only if it is still ours: a holder that lost it must not remove the next holder's. */
const unlock = (file: string, token: string) => {
  if (ownerOf(file) === token) rmSync(lockDir(file), { recursive: true, force: true });
};
const busy = (file: string, waitMs = WAIT_MS) => new Error(`The records in ${file} are busy (another request has held them for over ${Math.round(waitMs / 1000)} s). Try again.`);

/** For quick synchronous read-change-write steps (a registry entry, an index line). */
export function withFileLockSync<T>(file: string, fn: () => T, waitMs = SYNC_WAIT_MS): T {
  const until = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let token: string | null;
  while (!(token = tryLock(file, SYNC_STALE_MS))) {
    if (Date.now() > until) throw busy(file, waitMs);
    Atomics.wait(nap, 0, 0, 15);
  }
  try {
    return fn();
  } finally {
    unlock(file, token);
  }
}

// ---------- Exclusive work on one business's records, in this process and across instances ----------

const held = new AsyncLocalStorage<Set<string>>();
/** The file locks this async context holds, with their tokens (for assertLockHeld). */
const heldFiles = new AsyncLocalStorage<Map<string, string>>();

/**
 * Before saving a file this request holds the lock for: throw if the lock was lost (taken as stale while this request
 * stalled), so nothing overwrites the next holder's work. A no-op for a file this request does not hold a lock on.
 */
export function assertLockHeld(file: string) {
  const token = heldFiles.getStore()?.get(file);
  if (token && ownerOf(file) !== token) throw new Error("This request took too long and lost its hold on the records, so nothing it changed was saved. Try again.");
}
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
  let token: string | null = null;
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
      while (!(token = tryLock(file, STALE_MS))) {
        if (Date.now() > until) throw busy(file);
        await new Promise((r) => setTimeout(r, 25));
      }
      const mineToken = token;
      // Keep the lock fresh while slow work runs, so no other instance mistakes it for a dead one. Never refresh a lock
      // that is no longer ours.
      beat = setInterval(() => {
        try {
          if (ownerOf(file) !== mineToken) return;
          const now = new Date();
          utimesSync(lockDir(file), now, now);
        } catch {
          /* the lock went away: nothing to refresh */
        }
      }, Math.max(1000, STALE_MS / 4));
      beat.unref?.();
    }
    const files = new Map(heldFiles.getStore() ?? []);
    if (file && token) files.set(file, token);
    return await heldFiles.run(files, () => held.run(new Set([...(mine ?? []), key]), fn));
  } finally {
    if (beat) clearInterval(beat);
    if (token) unlock(file, token);
    done();
    if (q.get(key) === tail) q.delete(key);
  }
}
