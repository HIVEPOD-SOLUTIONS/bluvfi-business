import { ActionButton } from "@/components/Actions";
import { Badge } from "@/components/ui";
import { backupStatus, backupWarning } from "@/lib/backup";

const ago = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "never");
const size = (n?: number) => (n === undefined ? "" : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Backups of the whole platform, for owners of the operator's own business (lib/backup.ts). Server-rendered: no secret reaches the page. */
export function BackupSection() {
  const s = backupStatus();
  const warning = backupWarning();
  return (
    <section className="card mb-4" style={{ borderColor: warning ? "rgba(232,168,56,.4)" : "var(--bd-sage)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>Backups</h2>
        <Badge tone={!s.configured ? "bad" : warning ? "warn" : "ok"}>{!s.configured ? "Off" : warning ? "Needs attention" : "On"}</Badge>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
        Every business&apos;s records, the business list and the proofs, in one encrypted file (AES-256-GCM, under a key from the master key), every {s.everyHours} hours. Each file inside is checked on restore. Backups older than {s.keepDays} days are deleted, but the newest three are always kept.
      </p>
      {warning && <p role="alert" className="mt-2 text-sm" style={{ color: "#e8a838" }}>{warning}</p>}
      {s.configured && (
        <dl className="mt-3 grid gap-1 text-sm">
          <div><span className="label">Last good backup</span> {ago(s.lastOkAt)}{s.lastName ? ` · ${s.lastFiles} files · ${size(s.lastBytes)}` : ""}</div>
          <div><span className="label">Sent to</span> {s.destinations.join(" and ")}</div>
          {s.results?.map((r) => <div key={r.destination} className={r.ok ? "pos" : "neg"}>{r.ok ? "✓" : "✗"} {r.destination}{r.ok ? "" : `: ${r.error}`}</div>)}
        </dl>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {s.configured && <ActionButton url="/api/backup" small done="Backed up">Back up now</ActionButton>}
        <span className="text-xs" style={{ color: "var(--tx-2)" }}>
          Restore with the app stopped: <span className="mono">npm run backup -- restore &lt;name&gt; --force</span>. Keep BLUVFI_MASTER_KEY in a password or secrets manager too: without it no backup can be read.
        </span>
      </div>
    </section>
  );
}
