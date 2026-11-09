import { NextResponse } from "next/server";
import { backupSettingsView, clearBackupSettings, listBusinessBackups, restoreBusinessBackup, runBusinessBackup, setBackupSettings, type BackupSettingsInput } from "@/lib/business-backup";
import { body } from "@/lib/http";
import { clientKey, limited } from "@/lib/ratelimit";
import { cookieFrom, verifySessionFull } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { DEFAULT_BIZ, runAs } from "@/lib/tenant";

/**
 * A signed-up business's own backups (lib/business-backup.ts), for its owners. Not wrapped in route(): an upload must not hold the
 * business's records lock and make its other requests wait (a restore takes that lock itself).
 */
async function owner(req: Request): Promise<{ biz: string; name: string } | Response> {
  const s = await verifySessionFull(cookieFrom(req));
  if (!s) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  if (s.biz === DEFAULT_BIZ) return NextResponse.json({ error: "The operator's business is covered by the platform backup" }, { status: 400 });
  if (!runAs(s.biz, () => isOwner(s.name))) return NextResponse.json({ error: "Only an owner can manage this business's backups" }, { status: 403 });
  return s;
}

const json = (o: unknown, status = 200) => NextResponse.json(o, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: Request) {
  const who = await owner(req);
  if (who instanceof Response) return who;
  const settings = backupSettingsView(who.biz);
  let backups: { name: string; at: string }[] = [];
  let listError: string | undefined;
  if (settings.on) {
    try {
      backups = await runAs(who.biz, () => listBusinessBackups(who.biz));
    } catch (e) {
      listError = (e as Error).message;
    }
  }
  return json({ settings, backups, listError });
}

/** { action: "save", ...settings } | { action: "disconnect" } | { action: "run" } | { action: "restore", name } */
export async function POST(req: Request) {
  const who = await owner(req);
  if (who instanceof Response) return who;
  const wait = limited(`business-backup:${who.biz}:${clientKey(req)}`, 10);
  if (wait) return json({ error: `Too many requests. Try again in ${wait} seconds.` }, 429);
  const b = await body<BackupSettingsInput & { action?: string; name?: string }>(req);
  try {
    return await runAs(who.biz, async () => {
      switch (b.action) {
        case "save": {
          const { action: _a, name: _n, ...input } = b;
          void _a; void _n;
          await setBackupSettings(who.biz, input);
          // A first backup straight away, so a wrong key or bucket shows now rather than tomorrow.
          const first = await runBusinessBackup(who.biz).then((r) => ({ ok: true as const, name: r.lastName }), (e: Error) => ({ ok: false as const, error: e.message }));
          return json({ settings: backupSettingsView(who.biz), first });
        }
        case "disconnect":
          clearBackupSettings(who.biz);
          return json({ settings: backupSettingsView(who.biz) });
        case "run":
          return json({ result: await runBusinessBackup(who.biz), settings: backupSettingsView(who.biz) });
        case "restore":
          return json({ result: await restoreBusinessBackup(who.biz, String(b.name ?? "")) });
        default:
          return json({ error: "Unknown action" }, 400);
      }
    });
  } catch (e) {
    return json({ error: (e as Error).message, settings: backupSettingsView(who.biz) }, 400);
  }
}
