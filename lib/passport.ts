import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { getBusiness, setBusinessPassport } from "./business";
import { PASSPORT_ENABLED, PUBLIC_BASE_URL, SELF_ALLOW_TEST, SELF_API_KEY, SELF_BASE_URL, SELF_FLOW_ID, SELF_ORG_ID, SELF_WEBHOOK_SECRET } from "./config";
import { persist, state, withRecords } from "./store";
import { currentBiz, runAs } from "./tenant";
import { openText, sealText } from "./vault";
import { fileStamp, withFileLockSync, writeAtomic } from "./shared-file";
import type { PassportRecord } from "./types";

/**
 * Passport proofs through Self (self.xyz), the "collect less" way to verify: the person opens a hosted link, the Self app reads their
 * passport chip and makes a zero-knowledge proof that a real passport holder passing the flow's checks (OFAC screening, a minimum age) is
 * behind it. No name, number or document reaches this app or the counterparty; Self keeps nothing under org custody.
 *
 * As with Persona, the webhook is only a prompt: its Svix signature is checked, and then the proof itself is re-verified here with Self's
 * verifier (verifyProof) before anything counts. The proof's `nullifier` is the same for the same passport, so one passport cannot verify
 * two parties in a business.
 */
export const passportEnabled = () => PASSPORT_ENABLED;

/** The three calls to Self, swappable in tests. */
export const selfApi = {
  async createSession(externalUuid: string): Promise<{ verificationUrl: string }> {
    const { SelfClient } = await import("@selfxyz/enterprise-sdk");
    const client = new SelfClient({ apiKey: SELF_API_KEY, ...(SELF_BASE_URL ? { baseUrl: SELF_BASE_URL } : {}) });
    const base = PUBLIC_BASE_URL ? { successUrl: `${PUBLIC_BASE_URL}/passport/done`, failureUrl: `${PUBLIC_BASE_URL}/passport/done?failed=1` } : {};
    return client.sessions.create({ flowId: SELF_FLOW_ID, externalUuid, ...base });
  },
  async verifyWebhook(raw: string, headers: Record<string, string>) {
    const { SelfWebhooks } = await import("@selfxyz/enterprise-sdk");
    return SelfWebhooks.verify(raw, headers, SELF_WEBHOOK_SECRET);
  },
  async verifyProof(proof: unknown, proofAttributes: Record<string, unknown>, environment: "test" | "live"): Promise<boolean> {
    const { verifyProof } = await import("@selfxyz/enterprise-sdk");
    return (await verifyProof({ orgId: SELF_ORG_ID, proof: proof as never, proofAttributes, environment })).isValid;
  },
};

// ---------- Which session belongs to which business and vendor (the webhook carries only our external_uuid) ----------
interface Entry { biz: string; kind: "vendor" | "business"; vendor?: string }
const FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_PASSPORT_FILE ?? ".data/passport-index.json");
let index: Record<string, Entry> | undefined;
let indexStamp = "";
const readIndex = (): Record<string, Entry> => {
  if (!FILE || !existsSync(FILE)) return {};
  try {
    const stamp = fileStamp(FILE);
    const out = JSON.parse(openText(readFileSync(FILE, "utf8")).text) as Record<string, Entry>;
    indexStamp = stamp;
    return out;
  } catch {
    throw new Error(`Passport index ${FILE} is unreadable (or BLUVFI_MASTER_KEY is not the key it was sealed with). Fix or move it.`);
  }
};
/** The index, re-read when another instance has added to it (lib/shared-file.ts). */
const load = (): Record<string, Entry> => {
  if (index && (!FILE || fileStamp(FILE) === indexStamp)) return index;
  return (index = readIndex());
};
function remember(ref: string, e: Entry) {
  if (!FILE) {
    load()[ref] = e;
    return;
  }
  withFileLockSync(FILE, () => {
    const fresh = readIndex();
    fresh[ref] = e;
    writeAtomic(FILE, sealText(JSON.stringify(fresh)));
    indexStamp = fileStamp(FILE);
    index = fresh;
  });
}
/** Test helper. */
export const resetPassportIndex = () => { index = {}; };

/** Only the predicates the proof was checked against (age, OFAC, countries): never a value that could identify the person. */
function predicates(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!/age|ofac|sanction|countr/i.test(k)) continue;
    if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string" && v.length <= 64) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map(String).join(",").slice(0, 200);
  }
  return out;
}

/** Start a passport check for a vendor, or for this business (an owner proves it). Returns the hosted link to send. */
export async function startPassport(kind: "vendor" | "business", vendorName?: string): Promise<{ link: string; passport: PassportRecord }> {
  if (!PASSPORT_ENABLED) throw new Error("Passport checks are not set up: set SELF_API_KEY, SELF_FLOW_ID, SELF_WEBHOOK_SECRET and SELF_ORG_ID.");
  const biz = currentBiz();
  const v = kind === "vendor" ? state().vendors.find((x) => x.name === vendorName) : undefined;
  if (kind === "vendor" && !v) throw new Error("No such vendor");
  const ref = randomUUID();
  const session = await selfApi.createSession(ref);
  remember(ref, { biz, kind, vendor: v?.name });
  const passport: PassportRecord = { provider: "self", status: "pending", sessionRef: ref, updatedAt: new Date().toISOString() };
  if (v) {
    v.passport = passport;
    persist();
  } else setBusinessPassport(biz, passport);
  return { link: session.verificationUrl, passport };
}

/** Is this passport (nullifier) already behind another party of this business? One passport, one party. */
function usedElsewhere(nullifier: string, e: Entry): string | undefined {
  for (const v of state().vendors) if (v.passport?.status === "verified" && v.passport.nullifier === nullifier && !(e.kind === "vendor" && v.name === e.vendor)) return `vendor ${v.name}`;
  const b = getBusiness(e.biz)?.passport;
  if (b?.status === "verified" && b.nullifier === nullifier && e.kind !== "business") return "your own business";
  return undefined;
}

/**
 * Self's webhook. The Svix signature must verify, then the proof must re-verify with Self's verifier here: a signed event alone never
 * verifies anyone. Test-environment proofs (mock documents) count only with SELF_ALLOW_TEST=1.
 */
export async function handleSelfWebhook(raw: string, headers: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  if (!PASSPORT_ENABLED) return { ok: false, detail: "Passport checks are not set up" };
  let event: Awaited<ReturnType<typeof selfApi.verifyWebhook>>;
  try {
    event = await selfApi.verifyWebhook(raw, headers);
  } catch {
    return { ok: false, detail: "Bad signature" };
  }
  if (event.type !== "verification.completed") return { ok: true, detail: `Ignored ${event.type}` };
  const e = load()[event.external_uuid];
  if (!e) return { ok: true, detail: "Not one of ours" };

  return runAs(e.biz, () => withRecords(async () => {
    const now = new Date().toISOString();
    const current = e.kind === "vendor" ? state().vendors.find((x) => x.name === e.vendor)?.passport : getBusiness(e.biz)?.passport;
    // A newer passport check for the same party replaces this one: an old session must not overwrite it.
    if (!current || current.sessionRef !== event.external_uuid) return { ok: true, detail: "Superseded by a newer check" };

    let next: PassportRecord;
    if (event.status !== "valid") {
      next = { ...current, status: event.status === "invalid" ? "declined" : "pending", updatedAt: now, note: event.reason ?? `Self says ${event.status}` };
    } else if (event.environment === "test" && !SELF_ALLOW_TEST) {
      next = { ...current, status: "declined", updatedAt: now, environment: "test", note: "A test-environment proof (mock document): set SELF_ALLOW_TEST=1 to accept those." };
    } else if (!event.proof || !(await selfApi.verifyProof(event.proof, event.proof_attributes, event.environment).catch(() => false))) {
      next = { ...current, status: "declined", updatedAt: now, note: "The proof did not re-verify with Self's verifier." };
    } else {
      const dup = event.nullifier ? usedElsewhere(event.nullifier, e) : undefined;
      next = dup
        ? { ...current, status: "declined", updatedAt: now, note: `This passport already verified ${dup}. One passport verifies one party.` }
        : { ...current, status: "verified", updatedAt: now, verifiedAt: event.verified_at, nullifier: event.nullifier ?? undefined, environment: event.environment, checks: predicates(event.proof_attributes), note: undefined };
    }
    if (e.kind === "vendor") {
      const v = state().vendors.find((x) => x.name === e.vendor);
      if (v) v.passport = next;
      persist();
    } else setBusinessPassport(e.biz, next);
    return { ok: true, detail: `${e.kind === "vendor" ? e.vendor : "business"}: ${next.status}` };
  }));
}
