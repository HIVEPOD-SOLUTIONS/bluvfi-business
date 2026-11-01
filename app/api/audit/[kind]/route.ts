import { NextResponse } from "next/server";
import { createGrant, openWithKey, revokeGrant, toCsv, toPdf } from "@/lib/audit";
import { body, route, type Ctx } from "@/lib/http";
import { clientKey, limited } from "@/lib/ratelimit";
import { requireSigner } from "@/lib/session";
import { state } from "@/lib/store";

export const GET = route<Ctx<"kind">>(async (req, { params }) => {
  const { kind } = await params;
  await requireSigner(req);
  const payments = state().payments;
  if (kind === "csv")
    return new NextResponse(toCsv(payments), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="proofpay-audit.csv"' },
    });
  if (kind === "pdf")
    return new NextResponse(Buffer.from(await toPdf(payments)), {
      headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="proofpay-evidence.pdf"' },
    });
  throw new Error("Unknown export");
});

export const POST = route<Ctx<"kind">>(async (req, { params }) => {
  const { kind } = await params;
  if (kind === "open") {
    if (limited(`open:${clientKey(req)}`, 10)) throw new Error("Too many attempts. Wait a minute.");
  } else {
    await requireSigner(req);
  }
  const b = await body<{ grantee?: string; days?: number; id?: string; key?: string; on?: boolean }>(req);
  if (kind === "grant") {
    if (!b.grantee) throw new Error("Who is this for?");
    const g = createGrant(b.grantee, Math.max(1, Math.min(365, b.days ?? 30)));
    return { grant: { id: g.id, grantee: g.grantee, expiresAt: g.expiresAt }, viewKey: g.plainKey };
  }
  if (kind === "revoke") {
    revokeGrant(b.id ?? "");
    return { ok: true };
  }
  if (kind === "open") {
    const r = openWithKey(b.key ?? "");
    if (!r.ok) throw new Error(r.error);
    return { grantee: r.grantee, records: r.records.map((p) => ({ id: p.id, vendor: p.invoice.vendorName, amountUsd: p.invoice.amountUsd, status: p.status, headline: p.headline, recordHash: p.recordHash })) };
  }
  if (kind === "ledger") {
    state().ledgerPublic = !!b.on;
    return { ledgerPublic: state().ledgerPublic };
  }
  throw new Error("Unknown action");
});
