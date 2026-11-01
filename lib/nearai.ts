import { randomBytes } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";
import { NEAR_AI_BASE, NEAR_AI_KEY, NEAR_AI_MODEL } from "./config";
import { parseJudgment } from "./nearai-core";
import { checkMeasurements } from "./tdx";
import type { AiJudgment, Attestation, SignedDecision } from "./types";

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
 * Flow (docs.near.ai/cloud/verification): attestation with our own nonce first, then the completion,
 * then the response signature. The signed hashes cover the exact request and response bytes, so both
 * are kept as sent and received. Throws on any failure; the caller then holds the payment for a human.
 */
export async function judgeWithNearAi(requestBody: unknown): Promise<Judged> {
  if (!NEAR_AI_KEY) throw new Error("NEAR_AI_API_KEY is not set");
  const nonce = randomBytes(32).toString("hex");

  const attRes = await fetch(
    `${NEAR_AI_BASE}/attestation/report?${new URLSearchParams({ model: NEAR_AI_MODEL, provider: "near", include_tls_fingerprint: "false", signing_algo: ALGO, nonce })}`,
    { headers: headers(), signal: timeout() }
  );
  if (!attRes.ok) throw new Error(`NEAR AI attestation failed: ${attRes.status}`);
  const att = (await attRes.json()) as Report;

  const sentBody = JSON.stringify(requestBody);
  const chatRes = await fetch(`${NEAR_AI_BASE}/chat/completions`, {
    method: "POST",
    headers: headers({ "content-type": "application/json", "accept-encoding": "identity" }),
    body: sentBody,
    signal: timeout(),
  });
  if (!chatRes.ok) throw new Error(`NEAR AI chat failed: ${chatRes.status}`);
  const rawResponse = Buffer.from(await chatRes.arrayBuffer()).toString("utf8");
  const chat = JSON.parse(rawResponse) as { id: string; choices: { message: { content: string } }[] };
  const content = chat.choices[0].message.content;

  const sigRes = await fetch(`${NEAR_AI_BASE}/signature/${encodeURIComponent(chat.id)}?${new URLSearchParams({ signing_algo: ALGO })}`, { headers: headers(), signal: timeout() });
  if (!sigRes.ok) throw new Error(`NEAR AI signature failed: ${sigRes.status}`);
  const sig = (await sigRes.json()) as { text?: string; signature?: string; signing_address?: string; signature_kind?: string; error_code?: string; message?: string };
  if (sig.error_code || !sig.text || !sig.signature || !sig.signing_address) throw new Error(`NEAR AI signature unavailable: ${sig.message ?? sig.error_code ?? "empty"}`);
  if (sig.signature_kind !== "provider_tee" && sig.signature_kind !== "gateway") throw new Error("NEAR AI signature has an unknown signature_kind");

  // The report that must vouch for this signer: exactly one model report for provider_tee, the gateway report otherwise.
  const candidates: Report[] = sig.signature_kind === "gateway" ? [att.gateway_attestation].filter(Boolean) : (att.model_attestations ?? []);
  const matches = candidates.filter((c) => c.signing_address && norm(String(c.signing_address)) === norm(sig.signing_address!));
  if (matches.length !== 1) throw new Error(`NEAR AI attestation: ${matches.length} reports match the signer, expected exactly 1`);
  const rep = matches[0];

  const [cpu, gpu] = await Promise.all([verifyTdx(rep), verifyGpu(rep.nvidia_payload, nonce)]);
  const attestation: Attestation = {
    model: NEAR_AI_MODEL,
    nonce: String(rep.request_nonce ?? ""),
    signingAddress: String(rep.signing_address),
    signingAlgo: ALGO,
    gpuEvidence: { arch: "HOPPER", nonce: gpu.nonce, verified: gpu.ok, note: gpu.note },
    // reportData is read from the quote itself (the report does not return it), so it is only as trustworthy as `verified`.
    cpuEvidence: { type: "intel-tdx", reportData: cpu.reportData, verified: cpu.ok, note: cpu.note },
    source: "live",
  };
  return {
    decision: {
      chatId: chat.id,
      model: NEAR_AI_MODEL,
      content,
      rawResponse,
      signatureKind: sig.signature_kind,
      text: sig.text,
      signature: sig.signature,
      signingAddress: sig.signing_address,
      attestation,
      source: "live",
    },
    requestBody,
    expectedNonce: nonce,
    judgment: parseJudgment(content),
  };
}

/** NVIDIA NRAS: the decoded nvidia_payload is posted unchanged, its nonce must be ours, the overall result must be true. */
async function verifyGpu(payload: unknown, nonce: string) {
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
    const jwt = Array.isArray(body) && Array.isArray(body[0]) ? body[0][1] : undefined;
    const claims = jwt ? JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString()) : {};
    return { ok: claims["x-nvidia-overall-att-result"] === true, nonce: p.nonce, note: "Verdict from NVIDIA NRAS (TLS-authenticated; JWT signature not checked locally)." };
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
