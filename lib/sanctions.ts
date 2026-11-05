import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEMO } from "./config";
import type { SanctionsHit, SanctionsResult } from "./fraud";

/**
 * Sanctions screening against the US Treasury's OFAC SDN list, the public list that names sanctioned people, companies and crypto addresses.
 * Two things are matched:
 *  - the payout address, against the digital currency addresses the list publishes (a hit is certain, so it blocks);
 *  - the vendor's name, against every listed name and alias (a name match can be a different person or firm, so it warns and a human decides).
 * The list is downloaded from OFAC, kept in a cache file and refreshed daily. If OFAC cannot be reached the last copy is used and its age is
 * said; if there is no copy at all the answer is "unavailable", never "clear".
 */
const BASE = process.env.OFAC_BASE_URL ?? "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const CACHE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.OFAC_CACHE_FILE ?? ".data/sanctions.json");
const MAX_AGE_MS = 24 * 3_600_000;

interface Index {
  fetchedAt: number;
  /** When OFAC last changed the file (its Last-Modified header). */
  listDate: string;
  entities: Record<string, { n: string; t: string; p: string }>;
  /** Digital currency addresses: key is the address (lowercased for EVM) to [entity, currency]. */
  addresses: Record<string, [string, string]>;
  /** Normalised names and aliases to entity ids. */
  names: [string, string][];
}

/** Minimal CSV reader for OFAC's files: quoted fields, commas and newlines inside quotes, "" as an escaped quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const NOISE = new Set(["ltd", "llc", "inc", "co", "corp", "corporation", "gmbh", "sa", "plc", "limited", "company", "the", "ag", "bv", "nv", "pte", "pty", "llp", "lp"]);
/** Lowercase, no accents or punctuation, no company-form words, single spaces. */
export const normalizeName = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t && !NOISE.has(t)).join(" ");

const dash = (s: string | undefined) => (!s || s.trim() === "-0-" ? "" : s.trim());
const ADDRESS = /Digital Currency Address - ([A-Z0-9]+) ([A-Za-z0-9]+)/g;
/** EVM addresses are case-insensitive; every other chain's addresses are case-sensitive. */
const addressKey = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

export function buildIndex(sdnCsv: string, altCsv: string, listDate: string, now = Date.now()): Index {
  const idx: Index = { fetchedAt: now, listDate, entities: {}, addresses: {}, names: [] };
  for (const r of parseCsv(sdnCsv)) {
    const [ent, name, type, program, , , , , , , , remarks] = r;
    if (!ent || !name) continue;
    idx.entities[ent] = { n: name.trim(), t: dash(type), p: dash(program) };
    const n = normalizeName(name);
    if (n) idx.names.push([n, ent]);
    for (const m of (remarks ?? "").matchAll(ADDRESS)) idx.addresses[addressKey(m[2])] = [ent, m[1]];
  }
  for (const r of parseCsv(altCsv)) {
    const [ent, , , alias] = r;
    if (!ent || !idx.entities[ent] || !alias) continue;
    const n = normalizeName(alias);
    if (n) idx.names.push([n, ent]);
  }
  return idx;
}

let memory: Index | undefined;
let loading: Promise<Index | undefined> | undefined;

function readCache(): Index | undefined {
  try {
    if (CACHE && existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8")) as Index;
  } catch {
    /* an unreadable cache is just a missing one */
  }
  return undefined;
}

async function download(): Promise<Index> {
  const get = async (file: string) => {
    const r = await fetch(`${BASE}/${file}`, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok) throw new Error(`OFAC ${file}: HTTP ${r.status}`);
    return { text: await r.text(), date: r.headers.get("last-modified") ?? "" };
  };
  const [sdn, alt] = await Promise.all([get("SDN.CSV"), get("ALT.CSV")]);
  if (!sdn.text.includes(",") || sdn.text.length < 100_000) throw new Error("OFAC SDN.CSV looks empty or wrong");
  return buildIndex(sdn.text, alt.text, sdn.date ? new Date(sdn.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
}

/** The list, from memory, the cache file, or OFAC. A failed refresh keeps the older copy. */
export async function loadSanctions(force = false): Promise<Index | undefined> {
  if (!force && memory && Date.now() - memory.fetchedAt < MAX_AGE_MS) return memory;
  memory ??= readCache();
  if (!force && memory && Date.now() - memory.fetchedAt < MAX_AGE_MS) return memory;
  loading ??= (async () => {
    try {
      const fresh = await download();
      memory = fresh;
      if (CACHE) {
        mkdirSync(dirname(CACHE), { recursive: true });
        const tmp = CACHE + ".tmp";
        writeFileSync(tmp, JSON.stringify(fresh));
        renameSync(tmp, CACHE);
      }
    } catch {
      /* keep whatever copy there is */
    }
    return memory;
  })().finally(() => { loading = undefined; });
  return loading;
}

/** Test helper: forget the in-memory list. */
export const resetSanctions = () => { memory = undefined; };
/** Test helper: use this list instead of OFAC's. */
export const useSanctionsIndex = (idx: Index) => { memory = idx; };

const levenshteinWithin = (a: string, b: string, max: number): boolean => {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
};

export async function screenSanctions(input: { address?: string; name?: string }): Promise<SanctionsResult> {
  if (DEMO) return { status: "clear", hits: [], note: "Demo mode: the OFAC list is not downloaded." };
  const idx = await loadSanctions();
  if (!idx) return { status: "unavailable", hits: [], note: "The OFAC sanctions list could not be loaded and there is no earlier copy, so this payee was NOT screened." };
  const ageHours = Math.round((Date.now() - idx.fetchedAt) / 3_600_000);
  const base = { listDate: idx.listDate, ageHours };
  const hits: SanctionsHit[] = [];

  if (input.address) {
    const found = idx.addresses[addressKey(input.address)];
    if (found) {
      const e = idx.entities[found[0]];
      hits.push({ kind: "address", entity: e.n, program: e.p, matched: input.address, detail: `${found[1]} address listed for ${e.n}${e.p ? ` (${e.p})` : ""}` });
    }
  }
  const name = input.name ? normalizeName(input.name) : "";
  if (name.length >= 6) {
    const seen = new Set<string>();
    for (const [n, ent] of idx.names) {
      if (seen.has(ent)) continue;
      const exact = n === name;
      if (exact || (name.length >= 10 && levenshteinWithin(n, name, 1))) {
        seen.add(ent);
        const e = idx.entities[ent];
        hits.push({ kind: "name", entity: e.n, program: e.p, matched: input.name!, exact, detail: `${exact ? "Same name as" : "Name very close to"} ${e.n}${e.p ? ` (${e.p})` : ""}, an OFAC listing` });
      }
    }
  }
  return { status: hits.length ? "hit" : "clear", hits, ...base, note: hits.length ? "" : `Not on the OFAC list dated ${idx.listDate}.` };
}
