"use client";
import { ErrorLine, useAction } from "@/components/Actions";

export function LedgerToggle({ on }: { on: boolean }) {
  const { run, error, loading } = useAction();
  return (
    <div>
      <button role="switch" aria-checked={on} className={`btn ${on ? "btn-secondary" : "btn-primary"}`} disabled={loading} onClick={() => run("/api/audit/ledger", { on: !on })}>
        {on ? "Make private" : "Switch on transparency"}
      </button>
      <ErrorLine msg={error} />
    </div>
  );
}
