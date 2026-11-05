"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";
import type { KybStatus } from "@/lib/types";

const TONE: Record<KybStatus, "ok" | "warn" | "bad" | "default"> = { verified: "ok", declined: "bad", pending: "warn", submitted: "warn", review: "warn", expired: "default" };
const LABEL: Record<KybStatus, string> = { verified: "Verified", declined: "Failed verification", pending: "Verification sent", submitted: "Submitted, awaiting decision", review: "In review", expired: "Link expired" };

/** The verification state of a vendor or of the business, with the buttons to start it (and to pull the decision if the webhook is slow). */
export function KybControl({ kind, vendor, status, label }: { kind: "vendor" | "business"; vendor?: string; status?: KybStatus; label: string }) {
  const { run, error, loading } = useAction();
  const [link, setLink] = useState("");
  const payload = { kind, vendor };
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--line, #ddd)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status ? TONE[status] : "default"}>{status ? LABEL[status] : "Not verified"}</Badge>
        {status !== "verified" && (
          <button className="btn btn-secondary btn-sm" disabled={loading} onClick={async () => {
            const r = await run<{ link?: string }>("/api/kyb", payload);
            if (r?.link) setLink(r.link);
          }}>{status ? "Send a new link" : label}</button>
        )}
        {status && status !== "verified" && (
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => run("/api/kyb", { ...payload, refresh: true })}>Check the decision</button>
        )}
      </div>
      {link && (
        <p className="mt-2 text-sm break-all">
          Send this link to {kind === "vendor" ? "the vendor" : "your business owner"}: <a className="underline" href={link} target="_blank" rel="noreferrer">{link}</a>
        </p>
      )}
      <ErrorLine msg={error} />
    </div>
  );
}
