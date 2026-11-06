import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBusiness, setBusinessKyb } from "./business";
import { KYB_ENABLED, KYB_REQUIRED, PASSPORT_ENABLED, PERSONA_REDACT_AFTER_DAYS, PERSONA_API_KEY, PERSONA_BASE, PERSONA_TEMPLATE_BUSINESS, PERSONA_TEMPLATE_VENDOR, PERSONA_VERSION, PERSONA_WEBHOOK_SECRET } from "./config";
import { currentPolicy, persist, state } from "./store";
import { currentBiz, DEFAULT_BIZ, runAs } from "./tenant";
import { openText, sealText } from "./vault";
import type { Confidentiality, KybRecord, KybStatus } from "./types";
import { businessRequirement, standing, type VerificationTiers } from "./verify-tiers";

/**
 * Identity verification (KYB) through Persona. A vendor, or a business that signed up, is sent a hosted verification link. Persona decides
 * (approved or declined, by the workflow on its template) and tells us by webhook. The webhook is only a prompt to look: the status that
 * counts is the one fetched from Persona's API with our key, so a forged or replayed webhook cannot verify anyone. Nothing about the
 * person's documents ever reaches this app, only the decision.
 */
export const kybEnabled = () => KYB_ENABLED;

const headers = () => ({ authorization: `Bearer ${PERSONA_API_KEY}`, "content-type": "application/json", "persona-version": PERSONA_VERSION, "key-inflection": "kebab" });
/** A call to Persona. A dropped connection is retried once; creating an inquiry carries an Idempotency-Key so the retry cannot make a second one. */
const persona = async (path: string, init?: RequestInit, extra: Record<string, string> = {}) => {
  const go = () => fetch(`${PERSONA_BASE}/api/v1${path}`, { ...init, headers: { ...headers(), ...extra }, signal: AbortSignal.timeout(30_000) });
  try {
    return await go();
  } catch {
    return go();
  }
};

// ---------- Which inquiry belongs to which business and vendor (the webhook carries only the inquiry) ----------
interface Entry { biz: string; kind: "vendor" | "business"; vendor?: string }
const FILE = process.env.BLUVFI_PERSIST === "0" ? "" : (process.env.BLUVFI_KYB_FILE ?? ".data/kyb-index.json");
let index: Record<string, Entry> | undefined;
const load = (): Record<string, Entry> => {
  if (index) return index;
  index = {};
  if (FILE && existsSync(FILE)) {
    try {
      index = JSON.parse(openText(readFileSync(FILE, "utf8")).text) as Record<string, Entry>;
    } catch {
      throw new Error(`KYB index ${FILE} is unreadable (or BLUVFI_MASTER_KEY is not the key it was sealed with). Fix or move it.`);
    }
  }
  return index;
};
function remember(inquiryId: string, e: Entry) {
  load()[inquiryId] = e;
  if (!FILE) return;
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, sealText(JSON.stringify(index)));
  renameSync(tmp, FILE);
}
/** Test helper. */
export const resetKybIndex = () => { index = {}; };

// ---------- Status ----------
/** Persona's inquiry status to ours. Only "approved" verifies: "completed" means the person finished but no decision has been made. */
export function mapStatus(personaStatus: string): KybStatus {
  switch (personaStatus) {
    case "approved": return "verified";
    case "declined": case "failed": return "declined";
    case "needs_review": return "review";
    case "completed": return "submitted";
    case "expired": return "expired";
    default: return "pending"; // created, pending, and anything Persona adds later: not verified
  }
}

const FINAL: KybStatus[] = ["verified", "declined"];
/**
 * A record for this status. When the decision is final, `decidedAt` is set the first time and kept after, so retention counts from the
 * decision, not from the last refresh. A record whose documents were deleted keeps saying so.
 */
const rec = (status: KybStatus, inquiryId: string, prev?: KybRecord): KybRecord => {
  const now = new Date().toISOString();
  const same = prev?.inquiryId === inquiryId && prev.status === status;
  return {
    status, inquiryId, updatedAt: now,
    ...(FINAL.includes(status) ? { decidedAt: same && prev?.decidedAt ? prev.decidedAt : now } : {}),
    ...(same && prev?.redactedAt ? { redactedAt: prev.redactedAt } : {}),
  };
};

// ---------- Starting a verification ----------
const templateKey = (id: string) => (id.startsWith("itmplv_") ? "inquiry-template-version-id" : id.startsWith("itmpl_") ? "inquiry-template-id" : "template-id");

async function createInquiry(template: string, note: string): Promise<{ inquiryId: string; link: string }> {
  const res = await persona("/inquiries", {
    method: "POST",
    body: JSON.stringify({ data: { attributes: { [templateKey(template)]: template, note } }, meta: { "auto-create-one-time-link": true } }),
  }, { "idempotency-key": randomUUID() });
  const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }; meta?: { "one-time-link"?: string | null }; errors?: { detail?: string; title?: string }[] };
  if (!res.ok || !j.data?.id) throw new Error(`Persona could not start the verification (${res.status}): ${j.errors?.[0]?.detail ?? j.errors?.[0]?.title ?? "no reason given"}`);
  let link = j.meta?.["one-time-link"] ?? "";
  if (!link) {
    const r2 = await persona(`/inquiries/${j.data.id}/generate-one-time-link`, { method: "POST" });
    link = ((await r2.json().catch(() => ({}))) as { meta?: { "one-time-link"?: string } }).meta?.["one-time-link"] ?? "";
  }
  if (!link) throw new Error("Persona started the verification but gave no link to send");
  return { inquiryId: j.data.id, link };
}

/** Send a vendor a verification link. Returns the link to pass on to them. */
export async function startVendorVerification(vendorName: string): Promise<{ link: string; kyb: KybRecord }> {
  if (!KYB_ENABLED || !PERSONA_TEMPLATE_VENDOR) throw new Error("Vendor verification is not set up: it needs PERSONA_API_KEY and PERSONA_TEMPLATE_VENDOR");
  const v = state().vendors.find((x) => x.name === vendorName);
  if (!v) throw new Error("Unknown vendor");
  const { inquiryId, link } = await createInquiry(PERSONA_TEMPLATE_VENDOR, `bluvfi:${currentBiz()}:vendor:${vendorName}`.slice(0, 200));
  remember(inquiryId, { biz: currentBiz(), kind: "vendor", vendor: vendorName });
  v.kyb = rec("pending", inquiryId);
  persist();
  return { link, kyb: v.kyb };
}

/** Send the signed-up business its own verification link. */
export async function startBusinessVerification(): Promise<{ link: string; kyb: KybRecord }> {
  if (!KYB_ENABLED || !PERSONA_TEMPLATE_BUSINESS) throw new Error("Business verification is not set up: it needs PERSONA_API_KEY and PERSONA_TEMPLATE_BUSINESS");
  const biz = currentBiz();
  if (biz === DEFAULT_BIZ) throw new Error("This is the operator's own business: it is not verified through signup");
  const { inquiryId, link } = await createInquiry(PERSONA_TEMPLATE_BUSINESS, `bluvfi:${biz}:business`);
  remember(inquiryId, { biz, kind: "business" });
  const kyb = rec("pending", inquiryId);
  setBusinessKyb(biz, kyb);
  return { link, kyb };
}

// ---------- Reading the decision ----------
/** The status Persona holds for this inquiry, fetched with our key. */
async function fetchStatus(inquiryId: string): Promise<KybStatus> {
  const res = await persona(`/inquiries/${encodeURIComponent(inquiryId)}`);
  const j = (await res.json().catch(() => ({}))) as { data?: { attributes?: { status?: string } } };
  if (!res.ok || !j.data?.attributes?.status) throw new Error(`Persona did not return the inquiry (${res.status})`);
  return mapStatus(j.data.attributes.status);
}

/** The raw status and note of an inquiry, for a party that checks the decision for itself (lib/zk-attester.ts). */
export async function fetchInquiry(inquiryId: string): Promise<{ status: string; note: string }> {
  const res = await persona(`/inquiries/${encodeURIComponent(inquiryId)}`);
  const j = (await res.json().catch(() => ({}))) as { data?: { attributes?: { status?: string; note?: string } } };
  if (!res.ok || !j.data?.attributes?.status) throw new Error(`Persona did not return the inquiry (${res.status})`);
  return { status: j.data.attributes.status, note: j.data.attributes.note ?? "" };
}

/** Pull the current decision from Persona into the record it belongs to. Safe to call any time (it is what the Refresh button does). */
export async function refreshInquiry(inquiryId: string): Promise<KybRecord | undefined> {
  const e = load()[inquiryId];
  if (!e) return undefined;
  const status = await fetchStatus(inquiryId);
  return runAs(e.biz, () => {
    if (e.kind === "vendor") {
      const v = state().vendors.find((x) => x.name === e.vendor);
      // A newer inquiry for the same vendor replaces this one: an old inquiry must not overwrite it.
      if (!v || (v.kyb && v.kyb.inquiryId !== inquiryId)) return v?.kyb;
      v.kyb = rec(status, inquiryId, v.kyb);
      persist();
      return v.kyb;
    }
    const b = getBusiness(e.biz);
    if (!b || (b.kyb && b.kyb.inquiryId !== inquiryId)) return b?.kyb;
    return setBusinessKyb(e.biz, rec(status, inquiryId, b.kyb));
  });
}

/** Refresh whatever inquiry the vendor or this business has open. */
export async function refreshVendor(name: string) {
  const id = state().vendors.find((v) => v.name === name)?.kyb?.inquiryId;
  if (!id) throw new Error("No verification has been started for this vendor");
  return refreshInquiry(id);
}
export async function refreshBusiness() {
  const id = getBusiness(currentBiz())?.kyb?.inquiryId;
  if (!id) throw new Error("No verification has been started for this business");
  return refreshInquiry(id);
}

// ---------- Webhook ----------
/**
 * Persona signs each webhook: header `Persona-Signature: t=<unix seconds>,v1=<hex>`, where v1 is HMAC-SHA256 over `<t>.<raw body>` with the
 * webhook secret. While a secret is being rotated there is one `t=..,v1=..` pair per active secret, separated by spaces; any one matching is
 * enough. Anything older than five minutes is refused, so a captured webhook cannot be replayed.
 */
export function verifyPersonaSignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  if (!secret || !header) return false;
  for (const part of header.trim().split(/\s+/)) {
    const t = /(?:^|,)t=(\d+)/.exec(part)?.[1];
    const v1 = /(?:^|,)v1=([0-9a-f]+)/i.exec(part)?.[1];
    if (!t || !v1) continue;
    if (Math.abs(nowMs / 1000 - Number(t)) > 300) continue;
    const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
    const got = Buffer.from(v1, "hex");
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

export async function handlePersonaWebhook(rawBody: string, signature: string): Promise<{ ok: boolean; detail: string }> {
  if (!PERSONA_WEBHOOK_SECRET) return { ok: false, detail: "PERSONA_WEBHOOK_SECRET is not set" };
  if (!verifyPersonaSignature(rawBody, signature, PERSONA_WEBHOOK_SECRET)) return { ok: false, detail: "Bad signature" };
  let event: { data?: { attributes?: { name?: string; payload?: { data?: { type?: string; id?: string } } } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, detail: "Not JSON" };
  }
  const name = event.data?.attributes?.name ?? "";
  const inquiry = event.data?.attributes?.payload?.data;
  if (!name.startsWith("inquiry.") || inquiry?.type !== "inquiry" || !inquiry.id) return { ok: true, detail: `Ignored ${name || "event"}` };
  if (!load()[inquiry.id]) return { ok: true, detail: "Not one of ours" };
  // The event only says "look": the decision is what Persona's API says.
  const r = await refreshInquiry(inquiry.id);
  await redactDue().catch(() => undefined); // best effort: the scheduled poll retries
  return { ok: true, detail: `${name}: ${r?.status ?? "unknown"}` };
}

// ---------- Gate ----------
/**
 * Can this business release this payment? Its own verification is needed when the operator requires it of everyone (KYB_REQUIRED) or when
 * the council's tiers do (lib/verify-tiers.ts: from an amount, or for confidential payments), and a way to verify is set up. The operator's
 * own business is exempt. Returns the reason if not.
 */
export function businessGate(amountUsd = 0, confidentiality: Confidentiality = "basic", tiers: VerificationTiers = currentPolicy()): string | undefined {
  if ((!KYB_ENABLED && !PASSPORT_ENABLED) || currentBiz() === DEFAULT_BIZ) return undefined;
  const need = businessRequirement(amountUsd, confidentiality, tiers, KYB_REQUIRED && KYB_ENABLED);
  if (!need.required) return undefined;
  const b = getBusiness(currentBiz());
  const st = standing(b?.kyb, b?.passport, tiers);
  if (st.state === "verified") return undefined;
  return st.state === "declined"
    ? "Your business failed verification, so payments are stopped."
    : st.state === "open"
      ? `Your business ${st.how}, and ${need.why}. Payments like this wait until it is approved.`
      : `Your business has not been verified yet, and ${need.why}. Verify it on the Team page before paying.`;
}

// ---------- Short retention ----------
/**
 * Delete the documents at Persona once a decision has been final for PERSONA_REDACT_AFTER_DAYS, so only the verdict is kept anywhere:
 * Persona's DELETE /inquiries/{id} permanently removes the personal data of the inquiry and everything linked to it (it cannot be undone).
 * The decision is already recorded here, which is all this app ever uses. Each record says when its documents were deleted.
 */
export async function redactInquiry(inquiryId: string): Promise<void> {
  const r = await persona(`/inquiries/${encodeURIComponent(inquiryId)}`, { method: "DELETE" });
  // Already gone counts as done: there is nothing left to delete.
  if (!r.ok && r.status !== 404) throw new Error(`Persona would not delete inquiry ${inquiryId} (${r.status})`);
}

export interface RetentionPass { redacted: string[]; waiting: number; errors: string[] }

/** Every inquiry whose final decision is older than the retention period, across every business: delete its documents at Persona. */
export async function redactDue(now = Date.now()): Promise<RetentionPass> {
  const out: RetentionPass = { redacted: [], waiting: 0, errors: [] };
  if (PERSONA_REDACT_AFTER_DAYS === null || !KYB_ENABLED) return out;
  const due = PERSONA_REDACT_AFTER_DAYS * 86_400_000;
  for (const [inquiryId, e] of Object.entries(load())) {
    await runAs(e.biz, async () => {
      const record = e.kind === "vendor" ? state().vendors.find((x) => x.name === e.vendor)?.kyb : getBusiness(e.biz)?.kyb;
      if (!record || record.inquiryId !== inquiryId || !record.decidedAt || record.redactedAt) return;
      if (now - Date.parse(record.decidedAt) < due) {
        out.waiting++;
        return;
      }
      try {
        await redactInquiry(inquiryId);
        const done: KybRecord = { ...record, redactedAt: new Date(now).toISOString() };
        if (e.kind === "vendor") {
          const v = state().vendors.find((x) => x.name === e.vendor);
          if (v) v.kyb = done;
          persist();
        } else setBusinessKyb(e.biz, done);
        out.redacted.push(inquiryId);
      } catch (err) {
        out.errors.push((err as Error).message);
      }
    });
  }
  return out;
}
