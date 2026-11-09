/**
 * Runs once when the server starts (Next.js instrumentation). It starts the backup schedule: every 15 minutes it checks whether the
 * platform backup (lib/backup.ts) or any business's own backup (lib/business-backup.ts) is due, so backups happen even when no outside scheduler calls the settlement poll. With several
 * instances, a lock and the shared status file make sure only one of them makes each backup.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { backupIfDue } = await import("./lib/backup");
  const { businessBackupsDue } = await import("./lib/business-backup");
  const tick = () => {
    void businessBackupsDue().then((r) => {
      for (const [id, v] of Object.entries(r)) if (v.startsWith("failed")) console.error(`Backup of business ${id} ${v}`);
    });
    void backupIfDue().then((r) => {
      if (r.error) console.error(`Backup failed: ${r.error}`);
      else if (r.status?.results?.some((x) => !x.ok)) console.error(`Backup failed for ${r.status.results.filter((x) => !x.ok).map((x) => `${x.destination}: ${x.error}`).join("; ")}`);
    });
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}
