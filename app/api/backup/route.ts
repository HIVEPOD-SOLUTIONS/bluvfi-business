import { NextResponse } from "next/server";
import { backupStatus, backupWarning, runBackup } from "@/lib/backup";
import { cookieFrom, verifySessionFull } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { DEFAULT_BIZ, runAs } from "@/lib/tenant";

/**
 * Backups of the whole platform (lib/backup.ts). They hold every business's records, so only an owner of the operator's own business
 * may see their status or start one. Not wrapped in route(): a backup only reads files, and holding a business's records lock while
 * it uploads would make that business's requests wait.
 */
async function operatorOwner(req: Request): Promise<boolean> {
  const s = await verifySessionFull(cookieFrom(req));
  return !!s && s.biz === DEFAULT_BIZ && runAs(DEFAULT_BIZ, () => isOwner(s.name));
}

const no = () => NextResponse.json({ error: "Only an owner of the operator's business can manage backups" }, { status: 403 });

export async function GET(req: Request) {
  if (!(await operatorOwner(req))) return no();
  return NextResponse.json({ status: backupStatus(), warning: backupWarning() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await operatorOwner(req))) return no();
  try {
    const status = await runBackup();
    const failed = status.results?.filter((r) => !r.ok) ?? [];
    if (failed.length) return NextResponse.json({ error: `Backup failed for ${failed.map((r) => `${r.destination} (${r.error})`).join(", ")}`, status }, { status: 502 });
    return NextResponse.json({ status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
