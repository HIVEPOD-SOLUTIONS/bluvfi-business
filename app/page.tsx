import Link from "next/link";
import { KillSwitch } from "@/components/Actions";
import { Badge, Empty, PageHead, PaymentCard, Stat, usd } from "@/components/ui";
import { CHAIN_LABEL } from "@/lib/chains";
import type { Balance } from "@/lib/chain";
import { CUSTODY, DEMO, missingConfig } from "@/lib/config";
import { checkCustody } from "@/lib/custody";
import { services } from "@/lib/services";
import { currentPolicy, spentTodayUsd, state } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const s = state();
  const policy = currentPolicy();
  const missing = missingConfig();
  let balances: Balance[] = [];
  let balanceError = "";
  try {
    balances = await services.treasuryBalances();
  } catch (e) {
    balanceError = (e as Error).message;
  }
  const custody = await checkCustody().catch((e) => ({ mode: CUSTODY, ok: false, facts: [] as string[], problems: [(e as Error).message], killCommand: undefined as string | undefined }));
  const total = balances.filter((b) => b.usd).reduce((a, b) => a + b.amount, 0);
  const attention = s.payments.filter(
    (p) => p.status === "held" || p.status === "awaiting_approval" || p.status === "ready_to_send" || p.status === "proposed" || (p.status === "blocked" && p.callback?.status === "pending")
  );
  const blocked = s.payments.filter((p) => p.status === "blocked" || p.status === "cancelled").length;
  const allVerified = s.payments.length > 0 && s.payments.every((p) => p.verified.signature.valid);
  const saved = s.payments.filter((p) => p.status === "blocked" || p.status === "cancelled").reduce((a, p) => a + p.invoice.amountUsd, 0);

  return (
    <>
      <PageHead
        title="Overview"
        sub="An AI agent reads invoices and proposes payments. A policy gate decides whether money moves. Every decision leaves evidence."
        right={
          <div className="flex flex-wrap items-center gap-3">
            {s.payments.length > 0 && <Badge tone={allVerified ? "ok" : "warn"}>{allVerified ? "Verified ✓ every AI decision checked" : "Some decisions unverified"}</Badge>}
            <KillSwitch on={s.killSwitch} />
          </div>
        }
      />

      {missing.length > 0 && (
        <section role="alert" className="card mb-4" style={{ borderColor: "rgba(232,168,56,.4)" }}>
          <h2>Setup needed</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Set these environment variables and restart. Until then the affected features refuse to run.</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {missing.map((m) => <li key={m.key}><span className="mono">{m.key}</span> <span style={{ color: "var(--tx-2)" }}>— {m.why}</span></li>)}
          </ul>
        </section>
      )}

      {s.killSwitch && (
        <div role="status" className="card mb-4" style={{ borderColor: "rgba(224,82,82,.4)" }}>
          <strong className="neg">Kill switch is on.</strong> Every payment and API spend is stopped until a signer resumes.
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Treasury (USDC)" value={balanceError ? "—" : usd(total)} sub={balanceError ? "balance unavailable" : DEMO ? "demo balance" : "NEAR mainnet"} />
        <Stat label="Paid or reserved today" value={usd(spentTodayUsd())} sub={`of ${usd(policy.dailyLimitUsd)} daily limit`} />
        <Stat label="Stopped before paying" value={usd(saved)} sub={`${blocked} payment${blocked === 1 ? "" : "s"} blocked or cancelled`} tone={saved > 0 ? "pos" : undefined} />
        <Stat label="Policy" value={`v${policy.version}`} sub={<span className="mono">{policy.hash.slice(0, 12)}…</span>} />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2>Treasury balances</h2>
          {balanceError ? (
            <p className="mt-3 text-sm neg">Could not read the treasury: {balanceError}</p>
          ) : (
            <ul className="mt-3 divide-y" style={{ borderColor: "var(--bd)" }}>
              {balances.map((b) => (
                <li key={b.asset} className="flex items-center justify-between py-2.5" style={{ borderColor: "var(--bd)" }}>
                  <span>{CHAIN_LABEL[b.chain]} <span className="label ml-1">{b.asset}</span></span>
                  <span className="amount">{b.usd ? usd(b.amount) : b.amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>{DEMO ? "Demo balances, not read from the chain." : "Read live from NEAR mainnet. NEAR is shown in units, not converted."}</p>
        </div>

        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2>Needs your attention</h2>
            <Link href="/payments" className="text-sm" style={{ color: "#8c8cff" }}>All payments →</Link>
          </div>
          {s.payments.length === 0 ? (
            <Empty title="No payments yet" hint={s.vendors.length === 0 ? "Start by adding a vendor, then submit their invoice." : "Submit an invoice and the agent will review it."}>
              <Link className="btn btn-primary" href={s.vendors.length === 0 ? "/vendors" : "/payments"}>{s.vendors.length === 0 ? "Add a vendor" : "Submit an invoice"}</Link>
            </Empty>
          ) : attention.length === 0 ? (
            <Empty title="Nothing waiting on you" hint="Every payment is either settled or stopped." />
          ) : (
            <div className="grid gap-3">{attention.map((p) => <PaymentCard key={p.id} p={p} />)}</div>
          )}
        </div>
      </section>

      <section className="card mt-6" style={{ borderColor: custody.ok ? "var(--bd-sage)" : "rgba(224,82,82,.4)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>Who can move the money</h2>
          <Badge tone={custody.ok ? "ok" : "bad"}>{custody.ok ? `Custody: ${custody.mode} ✓` : `Custody: ${custody.mode}, check failed`}</Badge>
        </div>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>The AI has judgment, never authority. These facts are read from the chain or the custodian, not from this app&apos;s settings.</p>
        <ul className="mt-3 grid gap-1 text-sm">
          {custody.facts.map((f) => <li key={f}><span className="pos mono">✓</span> {f}</li>)}
          {custody.problems.map((f) => <li key={f}><span className="neg mono">✕</span> {f}</li>)}
        </ul>
        {custody.killCommand && (
          <details className="mt-3 text-sm">
            <summary style={{ color: "var(--tx-1)" }}>Hard stop: revoke the agent&apos;s key onchain</summary>
            <p className="mt-2" style={{ color: "var(--tx-2)" }}>The kill switch above stops this app. To also make the agent&apos;s key useless, its owner deletes it:</p>
            <pre className="mono mt-2 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{custody.killCommand}</pre>
          </details>
        )}
      </section>

      {s.payments.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3">Latest</h2>
          <div className="grid gap-3 md:grid-cols-2">{s.payments.slice(0, 4).map((p) => <PaymentCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </>
  );
}
