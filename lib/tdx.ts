import { createHash } from "node:crypto";

/**
 * Measurement checks from NEAR AI Cloud's verification docs (reference/quote-nonce-signer):
 * replay the runtime event log into RTMR3, and bind the raw app_compose string to MRCONFIGID.
 */
export interface TdxEvent {
  imr?: number;
  event_type?: number;
  digest?: string;
  event?: string;
  event_payload?: string;
}

const sha384 = (b: Uint8Array) => createHash("sha384").update(b).digest();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Replays the imr==3 events in order. Throws if a supplied digest does not match the recomputed one. */
export function replayRtmr3(eventLog: unknown): string {
  const events = (typeof eventLog === "string" ? JSON.parse(eventLog) : eventLog) as TdxEvent[];
  if (!Array.isArray(events)) throw new Error("event_log is not a list");
  let rtmr3: Buffer = Buffer.alloc(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type ?? 0);
    const computed = sha384(Buffer.concat([type, Buffer.from(":"), Buffer.from(e.event ?? "", "utf8"), Buffer.from(":"), Buffer.from(e.event_payload ?? "", "hex")]));
    if (e.digest && e.digest.toLowerCase().replace(/^0x/, "") !== hex(computed)) throw new Error(`event "${e.event}" digest does not match its payload`);
    rtmr3 = sha384(Buffer.concat([rtmr3, computed]));
  }
  return hex(rtmr3);
}

/** The raw app_compose string, from info.tcb_info (which may itself be JSON text). */
export function appCompose(info: unknown): string | undefined {
  const tcb = (info as { tcb_info?: unknown } | undefined)?.tcb_info;
  const parsed = typeof tcb === "string" ? (JSON.parse(tcb) as { app_compose?: unknown }) : (tcb as { app_compose?: unknown } | undefined);
  return typeof parsed?.app_compose === "string" ? parsed.app_compose : undefined;
}

/** MRCONFIGID must be 0x01, then SHA-256 of the raw app_compose string, then 15 zero bytes (48 bytes). */
export const expectedMrConfigId = (compose: string) => "01" + createHash("sha256").update(compose, "utf8").digest("hex") + "00".repeat(15);

export interface MeasurementResult { ok: boolean; problems: string[] }

/** Compare a report's event log and app_compose with the RTMR3 and MRCONFIGID of the verified quote. */
export function checkMeasurements(report: { event_log?: unknown; info?: unknown }, quote: { rtMr3: Uint8Array; mrConfigId: Uint8Array }): MeasurementResult {
  const problems: string[] = [];
  try {
    if (report.event_log === undefined) problems.push("no event_log to replay");
    else if (replayRtmr3(report.event_log) !== hex(quote.rtMr3)) problems.push("replayed RTMR3 does not match the quote");
  } catch (e) {
    problems.push(`event_log: ${(e as Error).message}`);
  }
  try {
    const compose = appCompose(report.info);
    if (compose === undefined) problems.push("no app_compose to hash");
    else if (expectedMrConfigId(compose) !== hex(quote.mrConfigId)) problems.push("MRCONFIGID does not bind this app_compose");
  } catch (e) {
    problems.push(`app_compose: ${(e as Error).message}`);
  }
  return { ok: problems.length === 0, problems };
}
