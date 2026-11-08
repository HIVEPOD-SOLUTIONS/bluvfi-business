import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NextResponse } from "next/server";
import { DEMO, MASTER_KEY } from "@/lib/config";

/**
 * Health check (public; used by the Docker HEALTHCHECK and any load balancer). 200 when this instance can serve: the master
 * key is set and the shared data folder can be written. 503 otherwise. It names no business and reveals no setting.
 */
export const dynamic = "force-dynamic";

const DATA_DIR = dirname(process.env.BLUVFI_DATA_FILE ?? ".data/state.json");

export function GET() {
  const checks: Record<string, boolean> = { masterKey: /^[0-9a-f]{64}$/i.test(MASTER_KEY) };
  try {
    if (process.env.BLUVFI_PERSIST !== "0") {
      mkdirSync(DATA_DIR, { recursive: true });
      accessSync(DATA_DIR, constants.W_OK);
    }
    checks.storage = true;
  } catch {
    checks.storage = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json({ ok, mode: DEMO ? "demo" : "live", checks }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
