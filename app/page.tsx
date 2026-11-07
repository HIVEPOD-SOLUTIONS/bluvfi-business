import { cfg } from "@/lib/business";
import { currentSigner, tenantPage } from "@/lib/who";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { ConfidentialPanel } from "./ConfidentialPanel";
import { loginStatus, shieldStatus } from "@/lib/confidential-flow";
import { isOwner, signerNames } from "@/lib/team";
import { NextStep } from "@/components/NextStep";
import Link from "next/link";
import { ActionButton, KillSwitch } from "@/components/Actions";
import { Badge, Empty, PageHead, PaymentCard, Stat, usd, when } from "@/components/ui";
import { CHAIN_LABEL } from "@/lib/chains";
import type { Balance } from "@/lib/chain";
import { DEMO, NEAR_AI_KEY, NEAR_AI_MODEL, NETWORK, missingConfig } from "@/lib/config";
import { modelStatus } from "@/lib/aimodel";
import { checkCustody, spendingWalletBand } from "@/lib/custody";
import { services } from "@/lib/services";
import { currentPolicy, spentTodayUsd, state } from "@/lib/store";

export const dynamic = "force-dynamic";

function BalanceList({ balances }: { balances: Balance[] }) {
  return (
    <ul className="mt-2 divide-y" style={{ borderColor: "var(--bd)" }}>
      {balances.map((b) => (
        <li key={b.asset} className="flex items-center justify-between py-2.5" style={{ borderColor: "var(--bd)" }}>
          <span>{CHAIN_LABEL[b.chain]} <span className="label ml-1">{b.asset}</span></span>
          <span className="amount">{b.usd ? usd(b.amount) : b.amount.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

async function Overview() {
  const s = state();
  const policy = currentPolicy();
  const tenant = currentBiz() !== DEFAULT_BIZ;
  const missing = missingConfig(cfg(), tenant);
  let balances: Balance[] = [];
  let balanceError = "";
  try {
    balances = await services.treasuryBalances();
  } catch (e) {
    balanceError = (e as Error).message;
  }
  // Hybrid custody: the DAO is the vault and an OutLayer wallet the agent spends from. Both are read from the chain.
  const hybrid = cfg().CUSTODY === "hybrid" && !DEMO;
  let wallet: Balance[] = [];
  let walletError = "";
  if (hybrid) {
    try {
      wallet = await services.spendingWalletBalances();
    } catch (e) {
      walletError = (e as Error).message;
    }
  }
  const band = hybrid ? spendingWalletBand() : undefined;
  const walletUsdc = wallet.find((b) => b.usd)?.amount;
  const ai = modelStatus();
  const custody = await checkCustody().catch((e) => ({ mode: cfg().CUSTODY, ok: false, facts: [] as string[], problems: [(e as Error).message], killCommand: undefined as string | undefined, councilKill: undefined as string | undefined }));
  const total = [...balances, ...wallet].filter((b) => b.usd).reduce((a, b) => a + b.amount, 0);
  const attention = s.payments.filter(
    (p) => p.status === "held" || p.status === "awaiting_approval" || p.status === "ready_to_send" || p.status === "proposed" || (p.status === "blocked" && p.callback?.status === "pending")
  );
  const blocked = s.payments.filter((p) => p.status === "blocked" || p.status === "cancelled").length;
  const allVerified = s.payments.length > 0 && s.payments.every((p) => p.verified.signature.valid);
  const saved = s.payments.filter((p) => p.status === "blocked" || p.status === "cancelled").reduce((a, p) => a + p.invoice.amountUsd, 0);

  // The single next thing to do, in plain words. Waiting payments come first (they are time-sensitive); then setup, in order.
  const steps = [
    { label: "Set up the treasury", done: missing.length === 0 },
    { label: "Add a vendor", done: s.vendors.length > 0 },
    { label: "Submit an invoice", done: s.payments.length > 0 },
    { label: "Add a second approver", done: signerNames().length >= 2 },
  ];
  const open = steps.findIndex((x) => !x.done);
  const next =
    attention.length > 0
      ? { title: `${attention.length} payment${attention.length === 1 ? " needs" : "s need"} you`, body: "Open the first one to approve it, send the funds, or stop it. Nothing moves until you do.", href: `/payments/${attention[0].id}`, cta: "Review it" }
      : open === 0
        ? { title: "Set up your treasury", body: "The treasury is where the money sits. Setup takes a few minutes, and you sign it with your own wallet. Until then payments cannot be sent.", href: "/setup", cta: "Set it up" }
        : open === 1
          ? { title: "Add your first vendor", body: "Vendors are the people you pay. Save where each gets paid and how to reach them, so the agent can spot a changed address.", href: "/vendors", cta: "Add a vendor" }
          : open === 2
            ? { title: "Send in an invoice", body: "Paste an invoice and watch the agent check it. Nothing is paid until your own rules say it may be.", href: "/payments", cta: "Submit an invoice" }
            : open === 3
              ? { title: "Add a second approver", body: "A policy change needs two different people, so no one person can change the rules alone. Add a teammate by email.", href: "/team", cta: "Open the team" }
              : { title: "You are all set", body: "Nothing needs you right now. The agent is watching, and you can stop every payment at any time with the kill switch above.", calm: true };

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

      <NextStep steps={steps} title={next.title} body={next.body} href={"href" in next ? next.href : undefined} cta={"cta" in next ? next.cta : undefined} calm={"calm" in next ? next.calm : undefined} kicker={attention.length > 0 ? "Needs you now" : undefined} />

      {missing.length > 0 && (
        <section role="alert" className="card mb-4" style={{ borderColor: "rgba(232,168,56,.4)" }}>
          <h2>{tenant ? "Finish setting up your business" : "Setup needed"}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{tenant ? "Your treasury is not set up yet, so payments cannot be sent. Setup takes a few minutes and your own wallet signs it." : "Set these environment variables and restart. Until then the affected features refuse to run."}</p>
          <ul className="mt-2 grid gap-1 text-sm">
            {!tenant && missing.map((m) => <li key={m.key}><span className="mono">{m.key}</span> <span style={{ color: "var(--tx-2)" }}>— {m.why}</span></li>)}
          </ul>
          {!cfg().DAO_ACCOUNT && !DEMO && <p className="mt-3 text-sm"><Link href="/setup" style={{ color: "#8c8cff" }}>Set up a treasury from the browser →</Link> <span style={{ color: "var(--tx-2)" }}>Your wallet creates the DAO and the agent; the settings are written for you.</span></p>}
        </section>
      )}

      {s.killSwitch && (
        <div role="status" className="card mb-4" style={{ borderColor: "rgba(224,82,82,.4)" }}>
          <strong className="neg">Kill switch is on.</strong> Every payment and API spend is stopped until a signer resumes.{s.killLog[0]?.on && <span style={{ color: "var(--tx-1)" }}> Turned on by {s.killLog[0].by}, {when(s.killLog[0].at)}.</span>}
          {s.payments.filter((p) => p.status === "proposed" && p.custody?.url).map((p) => (
            <div key={p.id} className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
              Still waiting onchain: {p.invoice.vendorName} (<a href={p.custody!.url} style={{ color: "#8c8cff" }}>open to reject</a>). The agent cannot withdraw it; a council member or the wallet owner must.
            </div>
          ))}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Treasury (USDC)" value={balanceError ? "—" : usd(total)} sub={balanceError ? "balance unavailable" : DEMO ? "demo balance" : hybrid ? `vault + spending wallet, NEAR ${NETWORK}` : `NEAR ${NETWORK}`} />
        <Stat label="Paid or reserved today" value={usd(spentTodayUsd())} sub={`of ${usd(policy.dailyLimitUsd)} daily limit`} />
        <Stat label="Stopped before paying" value={usd(saved)} sub={`${blocked} payment${blocked === 1 ? "" : "s"} blocked or cancelled`} tone={saved > 0 ? "pos" : undefined} />
        <Stat label="Policy" value={`v${policy.version}`} sub={<span className="mono">{policy.hash.slice(0, 12)}…</span>} />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2>Treasury balances</h2>
          {hybrid && <h3 className="label mt-3">Vault (DAO, council votes)</h3>}
          {balanceError ? (
            <p className="mt-3 text-sm neg">Could not read the treasury: {balanceError}</p>
          ) : (
            <BalanceList balances={balances} />
          )}
          {hybrid && (
            <>
              <h3 className="label mt-4">Spending wallet (OutLayer, agent pays from it)</h3>
              {walletError ? <p className="mt-2 text-sm neg">Could not read the spending wallet: {walletError}</p> : <BalanceList balances={wallet} />}
              {band && (
                <p className="mt-2 text-sm" style={{ color: "var(--tx-1)" }}>
                  {walletUsdc !== undefined && walletUsdc < band.low
                    ? <span style={{ color: "var(--amber)" }}>Below its {usd(band.low)} low mark. </span>
                    : null}
                  The agent asks the DAO to refill it to {usd(band.target)} when it falls under {usd(band.low)}. Its balance is the most that can leave without a council vote.
                </p>
              )}
              {s.topUp && (
                <p className="mt-2 text-sm">
                  Top-up {usd(s.topUp.amountUsd)}: DAO proposal #{s.topUp.proposalId}, {s.topUp.status === "InProgress" ? "waiting for council votes" : s.topUp.status.toLowerCase()}.{" "}
                  <a href={s.topUp.url} target="_blank" rel="noreferrer" style={{ color: "#8c8cff" }}>Open in Trezu</a>
                </p>
              )}
              <div className="mt-2"><ActionButton url="/api/custody/topup" small>Check and request a top-up</ActionButton></div>
            </>
          )}
          <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>{DEMO ? "Demo balances, not read from the chain." : `Read live from NEAR ${NETWORK}. NEAR is shown in units, not converted.`}</p>
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
        {custody.councilKill && (
          <details className="mt-3 text-sm">
            <summary style={{ color: "var(--tx-1)" }}>Hard stop by the council: remove the agent from its DAO role</summary>
            <p className="mt-2" style={{ color: "var(--tx-2)" }}>No key held by the agent&apos;s owner is needed. A council member files this proposal (Members in Trezu does the same), the council approves it, and the agent can no longer propose. This app notices within minutes and stops submitting.</p>
            <pre className="mono mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{custody.councilKill}</pre>
          </details>
        )}
        {custody.killCommand && (
          <details className="mt-3 text-sm">
            <summary style={{ color: "var(--tx-1)" }}>Hard stop: revoke the agent&apos;s key onchain</summary>
            <p className="mt-2" style={{ color: "var(--tx-2)" }}>The kill switch above stops this app. To also make the agent&apos;s key useless, its owner deletes it:</p>
            <pre className="mono mt-2 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{custody.killCommand}</pre>
          </details>
        )}
      </section>

      <ConfidentialPanel on={cfg().CONFIDENTIAL} status={loginStatus()} shield={shieldStatus()} owner={isOwner((await currentSigner()) ?? "")} canEnable={currentBiz() !== DEFAULT_BIZ && cfg().CUSTODY === "sputnik"} />

      <section className="card mt-6" style={{ borderColor: ai.checked && ai.passed > 0 ? "var(--bd-sage)" : "var(--bd)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>Private AI model</h2>
          <Badge tone={ai.checked ? (ai.passed > 0 ? "ok" : "bad") : "warn"}>{ai.checked ? `${ai.passed} of ${ai.total} instance${ai.total === 1 ? "" : "s"} attested` : "Not checked yet"}</Badge>
        </div>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
          {NEAR_AI_MODEL} on NEAR AI Cloud, inside a TEE. Checking it fetches the hardware attestation with a fresh nonce, verifies the Intel TDX quote, NVIDIA&apos;s signed GPU verdict
          and the binding of each signing key to that hardware, then registers the keys that pass. Every payment still checks its own attestation; this tells you the model is genuine before it reviews anything.
        </p>
        {ai.checked && (
          <ul className="mt-3 grid gap-1 text-sm">
            <li style={{ color: "var(--tx-2)" }}>Checked {when(ai.checkedAt)} · report <span className="mono">{ai.reportHash.slice(0, 12)}…</span></li>
            {ai.signers.map((x) => (
              <li key={x.signingAddress}>
                <span className={x.cpu && x.gpu && x.binding && x.nonceBound ? "pos mono" : "neg mono"}>{x.cpu && x.gpu && x.binding && x.nonceBound ? "✓" : "✕"}</span>{" "}
                <span className="mono">{x.signingAddress.slice(0, 16)}…</span> · CPU {x.cpu ? "✓" : "✕"} · GPU {x.gpu ? "✓" : "✕"} · key bound {x.binding ? "✓" : "✕"} · our nonce {x.nonceBound ? "✓" : "✕"}
                {x.notes.length > 0 && <span style={{ color: "var(--amber)" }}> · {x.notes.join(" ")}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          {NEAR_AI_KEY
            ? <ActionButton url="/api/ai/verify" small>{ai.checked ? "Check the model again" : "Verify the model now"}</ActionButton>
            : <span className="text-sm" style={{ color: "var(--tx-2)" }}>{DEMO ? "Demo mode replays signed fixtures; set NEAR_AI_API_KEY to check the live model." : "Set NEAR_AI_API_KEY to check the model."}</span>}
        </div>
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

export default tenantPage(Overview);
