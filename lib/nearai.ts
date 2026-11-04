import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCollateralAndVerify } from "@phala/dcap-qvl";
import { NEAR_AI_BASE, NEAR_AI_KEY, NEAR_AI_MODEL } from "./config";
import { canonical, sha256 } from "./crypto";
import { parseJudgment } from "./nearai-core";
import { verifyNrasJwt } from "./nras";
import { checkMeasurements } from "./tdx";
import type { AiJudgment, AiSource, Attestation, SignedDecision } from "./types";

export interface Judged {
  decision: SignedDecision;
  requestBody: unknown;
  expectedNonce: string;
  judgment: AiJudgment;
}

/** Per NEAR AI Cloud's verification docs: canonical model id, no aliasing, ed25519 for both calls. */
const ALGO = "ed25519";
const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${NEAR_AI_KEY}`,
  accept: "application/json",
  "x-no-aliasing": "true",
  ...extra,
});
const timeout = () => AbortSignal.timeout(60_000);
const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");

type Report = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Everything NEAR AI Cloud returned for one review, kept byte for byte so it can be verified again later.
 * Demo mode replays these from `fixtures/nearai/`; `source` says where a bundle came from.
 */
export interface NearAiBundle {
  model: string;
  nonce: string;
  requestBody: unknown;
  attestationReport: Report;
  rawResponse: string;
  signatureResponse: { text?: string; signature?: string; signing_address?: string; signature_kind?: string; error_code?: string; message?: string };
  recordedAt: string;
  source: AiSource;
  /** False when NEAR AI refused the response_format field and the request was sent again without it. */
  structured?: boolean;
}

/**
 * Raw attestation reports, kept by their hash so a payment record can point at the exact evidence it was judged under
 * and an auditor can verify it again later. Content-addressed: the same report is stored once.
 */
const ATTESTATION_DIR = join(process.cwd(), ".data", "attestations");
export const reportHash = (report: unknown) => sha256(canonical(report));
function keepReport(report: unknown): string {
  const h = reportHash(report);
  if (process.env.BLUVFI_PERSIST !== "0") {
    try {
      mkdirSync(ATTESTATION_DIR, { recursive: true });
      const file = join(ATTESTATION_DIR, `${h}.json`);
      if (!existsSync(file)) writeFileSync(file, JSON.stringify(report));
    } catch {
      /* evidence storage is best effort; the hash still goes on the record */
    }
  }
  return h;
}

/**
 * Flow (docs.near.ai/cloud/verification): attestation with our own nonce first, then the completion,
 * then the response signature. The signed hashes cover the exact request and response bytes, so both
 * are kept as sent and received. Throws on any failure; the caller then holds the payment for a human.
 */
export async function fetchNearAi(requestBody: unknown): Promise<NearAiBundle> {
  if (!NEAR_AI_KEY) throw new Error("NEAR_AI_API_KEY is not set");
  const nonce = randomBytes(32).toString("hex");

  const attestationReport = await fetchAttestation(nonce);

  const chat = (body: unknown) => fetch(`${NEAR_AI_BASE}/chat/completions`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "accept-encoding": "identity" }),
    body: JSON.stringify(body),
    signal: timeout(),
  });
  let structured = true;
  let chatRes = await chat(requestBody);
  // If NEAR AI does not take response_format for this model, ask once more without it. The reply is still held to the
  // schema by parseJudgment, and the record says the server did not enforce it. The signature covers what was sent.
  if ((chatRes.status === 400 || chatRes.status === 422) && requestBody && typeof requestBody === "object" && "response_format" in requestBody) {
    const { response_format: _dropped, ...plain } = requestBody as Record<string, unknown>;
    void _dropped;
    requestBody = plain;
    structured = false;
    chatRes = await chat(requestBody);
  }
  if (!chatRes.ok) throw new Error(`NEAR AI chat failed: ${chatRes.status}`);
  const rawResponse = Buffer.from(await chatRes.arrayBuffer()).toString("utf8");
  const chatId = (JSON.parse(rawResponse) as { id: string }).id;

  const sigRes = await fetch(`${NEAR_AI_BASE}/signature/${encodeURIComponent(chatId)}?${new URLSearchParams({ signing_algo: ALGO })}`, { headers: headers(), signal: timeout() });
  if (!sigRes.ok) throw new Error(`NEAR AI signature failed: ${sigRes.status}`);
  const signatureResponse = (await sigRes.json()) as NearAiBundle["signatureResponse"];
  return { model: NEAR_AI_MODEL, nonce, requestBody, attestationReport, rawResponse, signatureResponse, recordedAt: new Date().toISOString(), source: "live", structured };
}

async function fetchAttestation(nonce: string): Promise<Report> {
  const attRes = await fetch(
    `${NEAR_AI_BASE}/attestation/report?${new URLSearchParams({ model: NEAR_AI_MODEL, provider: "near", include_tls_fingerprint: "false", signing_algo: ALGO, nonce })}`,
    { headers: headers(), signal: timeout() }
  );
  if (!attRes.ok) throw new Error(`NEAR AI attestation failed: ${attRes.status}`);
  return (await attRes.json()) as Report;
}

/** One model instance's evidence, checked: Intel TDX, NVIDIA (signed verdict), and the key-and-nonce binding. */
export interface SignerCheck {
  signingAddress: string;
  cpu: boolean;
  gpu: boolean;
  binding: boolean;
  nonceBound: boolean;
  notes: string[];
}

/** The binding NEAR AI documents: the quote's report_data is the signing key right-padded to 32 bytes, then the nonce. */
export const bindsKeyAndNonce = (reportData: string, signingAddress: string, nonce: string) =>
  norm(reportData) === norm(signingAddress).padEnd(64, "0") + norm(nonce);

export interface ModelCheck {
  model: string;
  nonce: string;
  checkedAt: string;
  reportHash: string;
  signers: SignerCheck[];
}

/**
 * The setup-time check (Layer 2, step 1): fetch the attestation with a fresh random nonce, verify every model
 * instance's GPU and CPU evidence and the binding between them, and return the signing keys that passed. Spends no
 * inference credits: no chat request is made.
 */
export async function checkModel(): Promise<ModelCheck> {
  if (!NEAR_AI_KEY) throw new Error("NEAR_AI_API_KEY is not set");
  const nonce = randomBytes(32).toString("hex");
  const report = await fetchAttestation(nonce);
  const reports = (report.model_attestations ?? []) as Report[];
  if (!reports.length) throw new Error("The attestation has no model reports.");
  const signers = await Promise.all(reports.map(async (rep): Promise<SignerCheck> => {
    const [cpu, gpu] = await Promise.all([verifyTdx(rep), verifyGpu(rep.nvidia_payload, nonce)]);
    const addr = String(rep.signing_address ?? "");
    const nonceBound = norm(String(rep.request_nonce ?? "")) === norm(nonce) && norm(gpu.nonce) === norm(nonce);
    const binding = cpu.ok && bindsKeyAndNonce(cpu.reportData, addr, nonce);
    return { signingAddress: addr, cpu: cpu.ok, gpu: gpu.ok, binding, nonceBound, notes: [cpu.ok ? "" : cpu.note, gpu.ok ? "" : gpu.note].filter(Boolean) };
  }));
  return { model: NEAR_AI_MODEL, nonce, checkedAt: new Date().toISOString(), reportHash: keepReport(report), signers };
}

export const judgeWithNearAi = async (requestBody: unknown): Promise<Judged> => verifyNearAiBundle(await fetchNearAi(requestBody));

/** Check a bundle, live or recorded: the same signature, attestation and hardware checks run either way. */
export async function verifyNearAiBundle(b: NearAiBundle): Promise<Judged> {
  const sig = b.signatureResponse;
  if (sig.error_code || !sig.text || !sig.signature || !sig.signing_address) throw new Error(`NEAR AI signature unavailable: ${sig.message ?? sig.error_code ?? "empty"}`);
  if (sig.signature_kind !== "provider_tee" && sig.signature_kind !== "gateway") throw new Error("NEAR AI signature has an unknown signature_kind");
  const chat = JSON.parse(b.rawResponse) as { id: string; choices: { message: { content: string } }[] };
  const content = chat.choices[0].message.content;
  const att = b.attestationReport;
  const nonce = b.nonce;
  const rawResponse = b.rawResponse;
  const requestBody = b.requestBody;

  // The report that must vouch for this signer: exactly one model report for provider_tee, the gateway report otherwise.
  const candidates: Report[] = sig.signature_kind === "gateway" ? [att.gateway_attestation].filter(Boolean) : (att.model_attestations ?? []);
  const matches = candidates.filter((c) => c.signing_address && norm(String(c.signing_address)) === norm(sig.signing_address!));
  if (matches.length !== 1) throw new Error(`NEAR AI attestation: ${matches.length} reports match the signer, expected exactly 1`);
  const rep = matches[0];

  // A demo fixture was signed locally, so there is no hardware evidence to check and none is claimed.
  const demoNote = "Demo fixture: signed with the public demo key in lib/demo.ts, not by attested hardware. Record real reviews with `npm run fixtures:record`.";
  const [cpu, gpu] =
    b.source === "demo-fixture"
      ? [{ ok: false, reportData: "", note: demoNote }, { ok: false, nonce: "", note: "Demo fixture: no NVIDIA GPU evidence." }]
      : await Promise.all([verifyTdx(rep), verifyGpu(rep.nvidia_payload, nonce)]);
  const attestation: Attestation = {
    model: b.model,
    nonce: String(rep.request_nonce ?? ""),
    signingAddress: String(rep.signing_address),
    signingAlgo: ALGO,
    gpuEvidence: { arch: "HOPPER", nonce: gpu.nonce, verified: gpu.ok, note: gpu.note },
    // reportData is read from the quote itself (the report does not return it), so it is only as trustworthy as `verified`.
    cpuEvidence: { type: "intel-tdx", reportData: cpu.reportData, verified: cpu.ok, note: cpu.note },
    source: b.source,
    reportHash: b.source === "demo-fixture" ? reportHash(att) : keepReport(att),
    nrasToken: gpu.token,
    structured: b.structured !== false,
  };
  return {
    decision: {
      chatId: chat.id,
      model: b.model,
      content,
      rawResponse,
      signatureKind: sig.signature_kind,
      text: sig.text,
      signature: sig.signature,
      signingAddress: sig.signing_address,
      attestation,
      source: b.source,
    },
    requestBody,
    expectedNonce: nonce,
    judgment: parseJudgment(content),
  };
}

/**
 * NVIDIA NRAS: the decoded nvidia_payload is posted unchanged and its nonce must be ours. NVIDIA's answer is a signed
 * JWT, checked here (lib/nras.ts): ES384 against NVIDIA's published keys, issuer, expiry, our nonce, overall result.
 */
async function verifyGpu(payload: unknown, nonce: string): Promise<{ ok: boolean; nonce: string; note: string; token?: string }> {
  try {
    if (!payload) return { ok: false, nonce: "", note: "No NVIDIA GPU evidence in the attestation report." };
    const p = (typeof payload === "string" ? JSON.parse(payload) : payload) as { nonce?: string };
    if (typeof p.nonce !== "string" || p.nonce.toLowerCase() !== nonce.toLowerCase()) return { ok: false, nonce: String(p.nonce ?? ""), note: "GPU evidence nonce does not match ours." };
    const res = await fetch("https://nras.attestation.nvidia.com/v3/attest/gpu", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, nonce: p.nonce, note: `NRAS returned ${res.status}` };
    const body = (await res.json()) as unknown[];
    const jwt = Array.isArray(body) && Array.isArray(body[0]) ? String(body[0][1]) : "";
    if (!jwt) return { ok: false, nonce: p.nonce, note: "NRAS returned no verdict token." };
    const check = await verifyNrasJwt(jwt, p.nonce);
    return {
      ok: check.ok,
      nonce: p.nonce,
      token: jwt,
      note: check.ok ? "NVIDIA NRAS verdict verified: ES384 signature by NVIDIA's published key, our nonce, overall result true." : `NVIDIA NRAS verdict rejected: ${check.problems.join("; ")}.`,
    };
  } catch (e) {
    return { ok: false, nonce: "", note: `GPU verification error: ${(e as Error).message}` };
  }
}

/**
 * Intel TDX: the quote is verified with Phala's pure-JS dcap-qvl (collateral from Phala's PCCS; only "UpToDate"
 * counts), then the report is held to the docs' checks: report_data and request_nonce echoes agree with the
 * verified quote, the event log replays to the quote's RTMR3, and MRCONFIGID binds the raw app_compose.
 */
async function verifyTdx(rep: Report): Promise<{ ok: boolean; reportData: string; note: string }> {
  const quote = rep.intel_quote;
  if (typeof quote !== "string" || !quote) return { ok: false, reportData: "", note: "No Intel TDX quote in the attestation report." };
  try {
    const buf = /^(0x)?[0-9a-f]+$/i.test(quote) ? Buffer.from(quote.replace(/^0x/, ""), "hex") : Buffer.from(quote, "base64");
    const result = await getCollateralAndVerify(buf);
    const td = result.report.asTd10() ?? result.report.asTd15()?.base ?? null;
    if (!td) return { ok: false, reportData: "", note: "The quote is not an Intel TDX quote." };
    const reportData = Buffer.from(td.reportData).toString("hex");
    const problems: string[] = [];
    if (result.status !== "UpToDate") problems.push(`TCB status is ${result.status}`);
    if (rep.report_data && norm(String(rep.report_data)) !== reportData) problems.push("echoed report_data differs from the verified quote");
    problems.push(...checkMeasurements(rep, td).problems);
    return {
      ok: problems.length === 0,
      reportData,
      note: problems.length === 0 ? "Intel TDX quote verified (dcap-qvl, TCB UpToDate), RTMR3 replay and MRCONFIGID match." : `Intel TDX evidence rejected: ${problems.join("; ")}.`,
    };
  } catch (e) {
    return { ok: false, reportData: "", note: `Intel TDX verification error: ${(e as Error).message}` };
  }
}
