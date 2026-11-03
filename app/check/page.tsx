import { cfg } from "@/lib/business";
import { Badge, PageHead, Stat, when } from "@/components/ui";
import { ActionButton } from "@/components/Actions";

import { state } from "@/lib/store";
import { currentSession, publicBiz, tenantPage } from "@/lib/who";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { Playground, ReportForm, SpendDemo } from "./Playground";

export const dynamic = "force-dynamic";

const mask = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : `${v.slice(0, 3)}…`);

/** Check is public: `?b=<business id>` opens that business's own Check (its blocklist, its price list, paid to its treasury). */
async function Check() {
  const session = await currentSession();
  const signer = session && session.biz === currentBiz() ? session.name : "";
  const s = state();
  const recent = s.blocklist.slice(0, 6);
  const served = s.checkLog.length;
  const blocks = s.checkLog.filter((c) => c.verdict === "block").length;
  const curl = `curl -X POST "$HOST/api/check${currentBiz() === DEFAULT_BIZ ? "" : `?b=${currentBiz()}`}" \\
  -H "content-type: application/json" \\
  -H "X-PAYMENT: <x402 payment header>" \\
  -d '{"payoutAddress":"0x9f3b…","vendorName":"Acme Analytics Inc","vendorDomain":"acme-analytics.com","chain":"eth","amountUsd":8900}'`;
  return (
    <>
      <PageHead
        title="Bluvfi Business Check"
        sub="Any agent can ask, before it pays: is this payee safe? You get allow, warn or block with reasons. Every report this business files makes its own answers better."
        right={<Badge tone="gold">0.01 USDC per check · x402</Badge>}
      />
      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Blocklist" value={s.blocklist.length} sub="addresses and domains, each with evidence" />
        <Stat label="Checks served" value={served} sub="since this server started" />
        <Stat label="Blocks issued" value={blocks} />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2>Recent reports</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Anonymised: reporters and full values are not shown.</p>
          <ul className="mt-3 grid gap-3">
            {recent.length === 0 && <li className="text-sm" style={{ color: "var(--tx-1)" }}>No reports yet.</li>}
            {recent.map((b) => (
              <li key={b.id} className="rounded-xl p-3" style={{ background: "var(--bg-2)" }}>
                <div className="flex items-center justify-between gap-2"><Badge tone="bad">{b.kind}</Badge><span className="text-xs" style={{ color: "var(--tx-2)" }}>{when(b.at)}</span></div>
                <div className="mono mt-1 text-sm">{mask(b.value)}</div>
                <div className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{b.reason}</div>
                <div className="mono mt-1 text-xs" style={{ color: "var(--tx-2)" }}>evidence {b.evidenceHash.slice(0, 12)}…</div>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid content-start gap-4">
          <Playground biz={currentBiz() === DEFAULT_BIZ ? "" : currentBiz()} />
          <div className="card">
            <h2>Call it from your agent</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Without a payment header you get HTTP 402 and the price. Pay, retry, read the verdict. Machine-readable description: /api/openapi.</p>
            <pre className="mono mt-3 overflow-auto rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{curl}</pre>
          </div>
        </div>
      </section>

      {signer && (
        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <ReportForm />
          <SpendDemo />
        </section>
      )}
      {signer && cfg().AGENT_MARKET_TOKEN && (
        <section className="card mt-6">
          <h2>Agent Market</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Runs one pass over your hired jobs: checks the payee in each brief and submits the verdict. Schedule POST /api/agentmarket/poll to do this automatically.</p>
          <div className="mt-3"><ActionButton url="/api/agentmarket/poll" variant="secondary">Poll Agent Market now</ActionButton></div>
        </section>
      )}
    </>
  );
}

export default tenantPage(Check, ({ searchParams }: { searchParams: Promise<{ b?: string }> }) => publicBiz(searchParams));
