import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { DEMO } from "./config";
import { fileStamp, withFileLockSync, writeAtomic } from "./shared-file";

/**
 * Which business a piece of work belongs to. Every request runs inside one business (the session says which), and
 * everything that reads or writes business data (the store, the treasury settings, the team) looks the business up
 * here, so one business can never read or change another's records.
 *
 * "default" is the business of the operator who runs this copy of the app: its settings come from the environment
 * (.env.local), as before. Businesses that sign up on the platform get an id like bz_1a2b3c4d5e and keep their
 * settings in the business registry (lib/business.ts).
 */
export const DEFAULT_BIZ = "default";
export const BIZ_ID = /^bz_[0-9a-f]{10}$/;

/**
 * Demo or live, per business. A demo business runs on fixtures (a simulated DAO and chain, replayed AI reviews, no keys, no funds) and keeps
 * its records in a space of its own, apart from its live records; a live business uses the real services. A business that has never chosen
 * follows how this copy was started (BLUVFI_DEMO=1 is demo for everyone who has not chosen).
 */
export type Mode = "demo" | "live";
const MODES_FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_MODES_FILE ?? ".data/modes.json");
// Shared between instances like the other .data files (lib/shared-file.ts): re-read when another instance changed it.
const gm = globalThis as unknown as { __bluvfiModes?: Record<string, Mode>; __bluvfiModesStamp?: string; __bluvfiModesAt?: number };
function readModes(): Record<string, Mode> {
  if (!MODES_FILE || !existsSync(MODES_FILE)) return {};
  const stamp = fileStamp(MODES_FILE);
  // An unreadable file must not quietly put every business back on the default mode: it throws instead.
  const m = JSON.parse(readFileSync(MODES_FILE, "utf8")) as Record<string, Mode>;
  gm.__bluvfiModesStamp = stamp;
  return m;
}
function modes(): Record<string, Mode> {
  if (gm.__bluvfiModes) {
    if (!MODES_FILE || Date.now() - (gm.__bluvfiModesAt ?? 0) < 500) return gm.__bluvfiModes;
    gm.__bluvfiModesAt = Date.now();
    const now = fileStamp(MODES_FILE);
    if (!now || now === gm.__bluvfiModesStamp) return gm.__bluvfiModes;
  }
  gm.__bluvfiModesAt = Date.now();
  return (gm.__bluvfiModes = readModes());
}
export const modeOf = (biz: string): Mode => modes()[biz] ?? (DEMO ? "demo" : "live");
export function setMode(biz: string, mode: Mode) {
  if (!MODES_FILE) {
    modes()[biz] = mode;
    return;
  }
  withFileLockSync(MODES_FILE, () => {
    const m = readModes();
    m[biz] = mode;
    writeAtomic(MODES_FILE, JSON.stringify(m));
    gm.__bluvfiModesStamp = fileStamp(MODES_FILE);
    gm.__bluvfiModes = m;
  });
}
/** Test helper. */
export const resetModes = () => { gm.__bluvfiModes = {}; };

const als = new AsyncLocalStorage<{ biz: string; demo: boolean }>();

export const currentBiz = () => als.getStore()?.biz ?? DEFAULT_BIZ;
/** Is the work in hand running in demo? Outside any business (a script, a test) it follows how this copy was started. */
export const isDemo = () => als.getStore()?.demo ?? DEMO;
export const runAs = <T,>(biz: string, fn: () => T): T => als.run({ biz, demo: modeOf(biz) === "demo" }, fn);

/** A public link id (an invoice's pay link, an auditor's key) made inside a business carries its id, so the link finds its business. */
export const scopedId = (id: string) => (currentBiz() === DEFAULT_BIZ ? id : `${currentBiz()}~${id}`);
export const bizOfId = (id: string): string => {
  const [head, rest] = [id.split("~")[0], id.includes("~")];
  return rest && BIZ_ID.test(head) ? head : DEFAULT_BIZ;
};
