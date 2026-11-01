import Link from "next/link";
import type { Payment, PaymentStatus, Verdict } from "@/lib/types";

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function Badge({ tone = "default", children }: { tone?: "ok" | "warn" | "bad" | "gold" | "blue" | "default"; children: React.ReactNode }) {
  const cls = { ok: "badge-ok", warn: "badge-warn", bad: "badge-bad", gold: "badge-gold", blue: "badge-blue", default: "" }[tone];
  return <span className={`badge ${cls}`}>{children}</span>;
}

export const STATUS: Record<PaymentStatus, { label: string; tone: "ok" | "warn" | "bad" | "blue" | "default" }> = {
  paid: { label: "Paid", tone: "ok" },
  approved: { label: "Approved", tone: "ok" },
  ready_to_send: { label: "Send funds", tone: "blue" },
  proposed: { label: "Waiting for treasury", tone: "blue" },
  awaiting_approval: { label: "Needs approval", tone: "blue" },
  held: { label: "On hold", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "default" },
};

export const VERDICT: Record<Verdict, { icon: string; tone: "ok" | "warn" | "bad"; word: string }> = {
  allow: { icon: "✓", tone: "ok", word: "Passed" },
  warn: { icon: "!", tone: "warn", word: "Warning" },
  block: { icon: "✕", tone: "bad", word: "Blocked" },
};

export function PageHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1>{title}</h1>
        {sub && <p className="mt-1 max-w-2xl" style={{ color: "var(--tx-1)" }}>{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function Empty({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="card text-center py-10">
      <h2>{title}</h2>
      {hint && <p className="mt-1" style={{ color: "var(--tx-1)" }}>{hint}</p>}
      {children && <div className="mt-4 flex justify-center">{children}</div>}
    </div>
  );
}

const ALL_PROOFS = (p: Payment) => {
  const v = p.verified;
  return [
    { ok: v.signature.valid, label: "AI signature" },
    { ok: v.attestation.nonceBound && v.attestation.binding && v.attestation.gpu && v.attestation.cpu, label: "Attested" },
    { ok: v.pqSignature.valid, label: "ML-DSA" },
  ];
};

export function PaymentCard({ p }: { p: Payment }) {
  const st = STATUS[p.status];
  const failed = p.checks.filter((c) => c.verdict !== "allow");
  return (
    <Link href={`/payments/${p.id}`} className="card block">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span className="label">{p.invoice.invoiceNumber}</span>
          </div>
          <h2 className="mt-2">{p.invoice.vendorName}</h2>
        </div>
        <div className="amount text-xl">{usd(p.invoice.amountUsd)}</div>
      </div>
      <p className="mt-2" style={{ color: "var(--tx-0)" }}>{p.headline}</p>
      {failed.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {failed.filter((c) => c.id !== "ai").map((c) => (
            <li key={c.id}><Badge tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].icon} {c.label}</Badge></li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {ALL_PROOFS(p).map((x) => (
          <Badge key={x.label} tone={x.ok ? "ok" : "warn"}>{x.ok ? "✓" : "–"} {x.label}</Badge>
        ))}
        {p.callback && (
          <Badge tone={p.callback.status === "denied" ? "bad" : p.callback.status === "confirmed" ? "ok" : "warn"}>
            Vendor callback: {p.callback.status}
          </Badge>
        )}
      </div>
    </Link>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "pos" | "neg" }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`amount mt-2 text-2xl ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{sub}</div>}
    </div>
  );
}

export const short = (s: string, n = 10) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
export const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
