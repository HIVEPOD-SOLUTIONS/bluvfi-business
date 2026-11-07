"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";
import type { KybRecord, KybStatus, PassportRecord } from "@/lib/types";

const TONE: Record<KybStatus, "ok" | "warn" | "bad" | "default"> = { verified: "ok", declined: "bad", pending: "warn", submitted: "warn", review: "warn", expired: "default" };
const LABEL: Record<KybStatus, string> = { verified: "Verified", declined: "Failed verification", pending: "Verification sent", submitted: "Submitted, awaiting decision", review: "In review", expired: "Link expired" };
const P_TONE = { verified: "ok", declined: "bad", pending: "warn" } as const;
const P_LABEL = { verified: "Passport proof ✓", declined: "Passport check failed", pending: "Passport check sent" } as const;
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * How a vendor or the business stands with verification, and the buttons to start it. Two ways, either of which the council's policy can
 * accept: Persona (documents, held by Persona and deleted there after the retention period) and a passport proof through Self (a
 * zero-knowledge proof: real passport holder, of age, not on OFAC lists, with no name or document shared).
 */
export function KybControl({ kind, vendor, kyb, passport, personaOn, passportOn, label }: {
  kind: "vendor" | "business"; vendor?: string; kyb?: KybRecord; passport?: PassportRecord; personaOn: boolean; passportOn: boolean; label: string;
}) {
  const { run, error, loading } = useAction();
  const [link, setLink] = useState<{ url: string; via: string } | null>(null);
  const payload = { kind, vendor };
  const status = kyb?.status;
  const who = kind === "vendor" ? "the vendor" : "your business owner";
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--line, #ddd)" }}>
      {personaOn && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status ? TONE[status] : "default"}>{status ? LABEL[status] : "Not verified"}</Badge>
          {kyb?.redactedAt && <span className="text-xs" style={{ color: "var(--tx-2)" }}>Documents deleted at Persona on {day(kyb.redactedAt)}; only the decision is kept.</span>}
          {status !== "verified" && (
            <button className="btn btn-secondary btn-sm" disabled={loading} aria-busy={loading} onClick={async () => {
              const r = await run<{ link?: string }>("/api/kyb", payload);
              if (r?.link) setLink({ url: r.link, via: "Persona" });
            }}>{status ? "Send a new link" : label}</button>
          )}
          {status && status !== "verified" && (
            <button className="btn btn-ghost btn-sm" disabled={loading} aria-busy={loading} onClick={() => run("/api/kyb", { ...payload, refresh: true })}>Check the decision</button>
          )}
        </div>
      )}
      {passportOn && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone={passport ? P_TONE[passport.status] : "default"}>{passport ? P_LABEL[passport.status] : "No passport proof"}</Badge>
          {passport?.status === "verified" && <span className="text-xs" style={{ color: "var(--tx-2)" }}>Proved {day(passport.verifiedAt)}{passport.environment === "test" ? " (test environment)" : ""}: no name or document shared.</span>}
          {passport?.note && passport.status !== "verified" && <span className="text-xs" style={{ color: "var(--tx-2)" }}>{passport.note}</span>}
          {passport?.status !== "verified" && (
            <button className="btn btn-secondary btn-sm" disabled={loading} aria-busy={loading} onClick={async () => {
              const r = await run<{ link?: string }>("/api/passport", payload);
              if (r?.link) setLink({ url: r.link, via: "Self" });
            }}>{passport ? "Send a new passport link" : "Check with a passport (no documents)"}</button>
          )}
        </div>
      )}
      {link && (
        <p className="mt-2 text-sm break-all">
          Send this {link.via} link to {who}: <a className="underline" href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
        </p>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}
