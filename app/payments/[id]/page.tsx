import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/Actions";
import { Badge, PageHead, STATUS, short, usd, when } from "@/components/ui";
import { state } from "@/lib/store";
import { currentSigner } from "@/lib/who";
import { SendPanel } from "./SendPanel";

export const dynamic = "force-dynamic";

function Row({ ok, label, children }: { ok: boolean | null; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-2.5 border-b" style={{ borderColor: "var(--bd)" }}>
      <span className={`mono mt-0.5 w-5 shrink-0 text-center ${ok === null ? "" : ok ? "pos" : "neg"}`}>{ok === null ? "–" : ok ? "✓" : "✕"}</span>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {children && <div className="text-sm break-words" style={{ color: "var(--tx-1)" }}>{children}</div>}
      </div>
    </li>
  );
}

export default async function PaymentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signer = await currentSigner();
  const p = state().payments.find((x) => x.id === id);
  if (!p) notFound();
  const v = p.verified;
  const st = STATUS[p.status];
  const canApprove = !!signer && (p.status === "awaiting_approval" || p.status === "held");
  const canCancel = !!signer && p.status !== "paid" && p.status !== "cancelled" && !(p.status === "ready_to_send" && p.txRef);

  return (
    <>
      <p className="mb-3 text-sm"><Link href="/payments" style={{ color: "#8c8cff" }}>← Payments</Link></p>
      <PageHead
        title={`${p.invoice.vendorName} · ${usd(p.invoice.amountUsd)}`}
        sub={p.headline}
        right={<Badge tone={st.tone}>{st.label}</Badge>}
      />

      <section className="card mb-4">
        <h2>What happened</h2>
        <p className="mt-1" style={{ color: "var(--tx-1)" }}>{p.reason}</p>
        {(canApprove || canCancel) && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {canApprove && <ActionButton url={`/api/payments/${p.id}/approve`} variant="primary">Approve as {signer}</ActionButton>}
            {canCancel && <ActionButton url={`/api/payments/${p.id}/cancel`} variant="danger" confirm="Cancel this payment?">Cancel payment</ActionButton>}
          </div>
        )}
        {p.holdUntil && p.status === "held" && <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>Hold window ends {when(p.holdUntil)}. Nothing leaves until a signer approves.</p>}
        {p.approvedBy && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Approved by <span className="mono">{p.approvedBy}</span>.</p>}
      </section>

      {p.status === "ready_to_send" && p.quote && <SendPanel id={p.id} quote={p.quote} txRef={p.txRef} settlement={p.settlement} signedIn={!!signer} asset={p.invoice.asset} chain={p.invoice.chain} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card" style={{ borderColor: "var(--bd-sage)" }}>
          <div className="flex items-center justify-between">
            <h2>Verified</h2>
            <Badge tone={v.signature.valid ? "ok" : "bad"}>{v.signature.valid ? "Signature checks out" : "Signature failed"}</Badge>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Exactly what was checked on this payment.</p>
          <ul className="mt-2">
            <Row ok={v.attestation.nonceBound} label="Fresh attestation (nonce)">
              <span className="mono">{short(v.attestation.nonce, 12)}</span> · {v.attestation.nonce ? "live from NEAR AI Cloud" : "AI review did not run"}
            </Row>
            <Row ok={v.attestation.gpu} label="GPU attestation (NVIDIA)">{v.attestation.gpu ? "Confidential-computing GPU evidence accepted." : "Not verified."}</Row>
            <Row ok={v.attestation.cpu} label="CPU attestation (Intel TDX)">{v.attestation.cpu ? "CPU quote accepted." : "Not verified in this run."}</Row>
            <Row ok={v.attestation.binding} label="Key bound to hardware">The signing key and nonce appear in the CPU report.</Row>
            <Row ok={v.signature.valid} label="Model signature (ed25519)">
              <span className="mono">{short(v.signature.signingAddress, 10)}</span> signed <span className="mono">{short(v.signature.text, 10)}</span>. Request {v.signature.requestBound ? "matches" : "does NOT match"}; response {v.signature.responseBound ? "matches" : "does NOT match"}. Verified off-chain.
            </Row>
            <Row ok label={`Policy v${v.policyVersion}`}><span className="mono">{short(v.policyHash, 12)}</span></Row>
            {p.checks.map((c) => (
              <Row key={c.id} ok={c.verdict === "allow" ? true : c.verdict === "warn" ? null : false} label={c.label}>{c.reason}</Row>
            ))}
            <Row ok={p.callback ? p.callback.status === "confirmed" : null} label="Vendor callback">
              {p.callback ? `${p.callback.status}${p.callback.answer ? ` — “${p.callback.answer}”` : ""}` : "Not needed."}
            </Row>
            <Row ok={v.pqSignature.valid} label="Post-quantum signature (ML-DSA-65)">
              Record signed with a quantum-resistant key, so the evidence stays trustworthy later.
            </Row>
            <Row ok={null} label="Zero-knowledge proof of the policy check">Not available. The policy check is deterministic code you can re-run against the recorded policy hash.</Row>
          </ul>
          {v.attestation.notes.map((n) => <p key={n} className="mt-2 text-sm" style={{ color: "var(--amber)" }}>{n}</p>)}
        </section>

        <div className="grid gap-4 content-start">
          <section className="card">
            <h2>The AI’s opinion</h2>
            <div className="mt-2 flex items-center gap-2">
              <Badge tone={p.ai.decision === "pay" ? "ok" : p.ai.decision === "hold" ? "warn" : "bad"}>Recommends: {p.ai.decision}</Badge>
              <span className="label">risk {p.ai.riskScore}/100</span>
            </div>
            <p className="mt-2">{p.ai.summary}</p>
            <ul className="mt-2 list-disc pl-5 text-sm" style={{ color: "var(--tx-1)" }}>{p.ai.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>It can only recommend. The policy gate and fraud checks decide, and can overrule it.</p>
          </section>

          {p.callback && (
            <section className="card">
              <h2>Vendor callback</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
                Sent to <span className="mono">{p.callback.handle}</span> on {p.callback.channel} ({p.callback.delivered === "telegram" ? "delivered on Telegram" : p.callback.delivered === "voice" ? "voice call placed" : "not automated: contact the vendor yourself and record the answer below"}), a channel we already had on file, not the one in the invoice.
              </p>
              <blockquote className="mt-2 rounded-lg p-3 text-sm" style={{ background: "var(--bg-2)" }}>{p.callback.message}</blockquote>
              {p.callback.answer && <p className="mt-2 text-sm"><strong>Reply:</strong> {p.callback.answer}</p>}
              {p.callback.status === "pending" && !!signer && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton url={`/api/payments/${p.id}/callback`} payload={{ answer: "no" }} variant="danger" small>Vendor said “not us”</ActionButton>
                  <ActionButton url={`/api/payments/${p.id}/callback`} payload={{ answer: "yes" }} variant="secondary" small>Vendor said “yes”</ActionButton>
                </div>
              )}
            </section>
          )}

          <section className="card">
            <h2>Payment rail</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt style={{ color: "var(--tx-2)" }}>Rail</dt><dd>NEAR Intents (1Click)</dd>
              <dt style={{ color: "var(--tx-2)" }}>Pay to</dt><dd className="mono break-all">{p.invoice.payoutAddress} ({p.invoice.chain})</dd>
              <dt style={{ color: "var(--tx-2)" }}>Privacy</dt><dd>{p.confidentiality}</dd>
              {p.quote && (<><dt style={{ color: "var(--tx-2)" }}>Quote</dt><dd className="mono">{p.quote.amountIn} → {p.quote.amountOut} (1Click, mainnet)</dd></>)}
              {p.txRef && (<><dt style={{ color: "var(--tx-2)" }}>Reference</dt><dd className="mono">{p.txRef}</dd></>)}
            </dl>
            <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>Proofpay stops money before it leaves. Funds already settled on another chain cannot be frozen.</p>
          </section>
        </div>
      </div>

      <section className="card mt-4">
        <h2>What the model saw</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>Contact details, bank details and wallets are stripped before any reasoning call. The original invoice text:</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div><div className="label mb-1">Original (stays on this server)</div><pre className="mono overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{p.invoice.text.replace(/​/g, "␣")}</pre></div>
          <div><div className="label mb-1">Sent to the private model</div><pre className="mono overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{p.redactedInput.replace(/​/g, "␣")}</pre></div>
        </div>
        <p className="mono mt-3 break-all text-xs" style={{ color: "var(--tx-2)" }}>record {p.recordHash} · previous {short(p.prevHash, 12)} · {when(p.createdAt)}</p>
      </section>
    </>
  );
}
