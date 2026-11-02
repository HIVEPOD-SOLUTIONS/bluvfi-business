import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/Actions";
import { Badge, PageHead, STATUS, short, usd, when } from "@/components/ui";
import { refreshZk } from "@/lib/agent";
import { state } from "@/lib/store";
import { currentSigner } from "@/lib/who";
import { GaslessVote } from "@/components/GaslessVote";
import { CUSTODY, DAO_ACCOUNT, DEMO, NEAR_RPC_URL } from "@/lib/config";
import { relayerEnabled, viewDao } from "@/lib/custody";
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
  const found = state().payments.find((x) => x.id === id);
  if (!found) notFound();
  const p = await refreshZk(found);
  const v = p.verified;
  const st = STATUS[p.status];
  const inHold = p.status === "held" && !!p.holdUntil && new Date(p.holdUntil) > new Date();
  const canApprove = !!signer && !inHold && (p.status === "awaiting_approval" || p.status === "held");
  const canCancel = !!signer && p.status !== "paid" && p.status !== "cancelled" && !(p.status === "ready_to_send" && p.txRef);
  const c = p.custody;
  // act_proposal must repeat the proposal kind exactly as the DAO stored it, so read it from the chain when we can.
  let kind = c?.kind;
  if (c?.backend === "sputnik" && c.state === "pending" && !DEMO) kind = (await viewDao<{ kind: unknown }>("get_proposal", { id: Number(c.ref) }).catch(() => null))?.kind ?? kind;
  const aiSource = v.attestation.source === "demo-fixture" ? "demo fixture, signed with the public demo key" : v.attestation.source === "recorded" ? "a recorded NEAR AI Cloud response, re-verified now" : "live from NEAR AI Cloud";

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
        {p.holdUntil && p.status === "held" && <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>{inHold ? `In its hold window until ${when(p.holdUntil)}: it can be cancelled now and approved after that.` : `Hold window ended ${when(p.holdUntil)}. Nothing leaves until a signer approves.`}</p>}
        {p.approvedBy && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Approved by <span className="mono">{p.approvedBy}</span>.</p>}
      </section>

      {p.status === "ready_to_send" && p.quote && !c && <SendPanel id={p.id} quote={p.quote} txRef={p.txRef} settlement={p.settlement} signedIn={!!signer} asset={p.invoice.asset} chain={p.invoice.chain} />}

      {c && (
        <section className="card mb-4" style={{ borderColor: "rgba(10,10,232,.5)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2>Treasury</h2>
            <Badge tone={c.state === "executed" ? "ok" : c.state === "pending" ? "blue" : "bad"}>{c.backend === "sputnik" ? `DAO proposal #${c.ref}` : "OutLayer wallet"} · {c.state}</Badge>
          </div>
          {c.route && <p className="mt-1 text-sm"><span className="label">Route</span> {c.route}</p>}
          <p className="mt-1" style={{ color: "var(--tx-1)" }}>{c.detail}</p>
          <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>
            {c.backend === "sputnik"
              ? `The agent's NEAR key can only call add_proposal on ${DAO_ACCOUNT}. Money moves when the council approves, and the approving vote executes the transfer.`
              : "The agent holds only an OutLayer API key. OutLayer enforces the owner's limits and approvals inside Intel TDX."}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt style={{ color: "var(--tx-2)" }}>Evidence onchain</dt><dd className="mono break-all">{c.evidenceHash}</dd>
            {p.quote && (<><dt style={{ color: "var(--tx-2)" }}>Pays</dt><dd className="mono break-all">{p.quote.amountIn} USDC → {p.quote.depositAddress}</dd></>)}
            {c.votes && Object.keys(c.votes).length > 0 && (<><dt style={{ color: "var(--tx-2)" }}>Votes</dt><dd>{Object.entries(c.votes).map(([who, how]) => `${who}: ${how}`).join(", ")}</dd></>)}
            {c.txHash && (<><dt style={{ color: "var(--tx-2)" }}>Transaction</dt><dd className="mono break-all">{c.txHash}</dd></>)}
          </dl>
          {c.state === "pending" && (
            <div className="mt-4 grid gap-3">
              <div className="flex flex-wrap gap-2">
                {c.url && !DEMO && <a className="btn btn-secondary btn-sm" href={c.url} target="_blank" rel="noreferrer">{c.backend === "sputnik" ? "Vote in Trezu" : "Open OutLayer approvals"}</a>}
                {!!signer && <ActionButton url={`/api/payments/${p.id}/settlement`} variant="secondary" small>Check status</ActionButton>}
                {DEMO && !!signer && <ActionButton url={`/api/payments/${p.id}/vote`} payload={{ approve: true }} variant="primary" small>Vote approve as {signer} (demo DAO)</ActionButton>}
                {DEMO && !!signer && <ActionButton url={`/api/payments/${p.id}/vote`} payload={{ approve: false }} variant="danger" small>Vote reject</ActionButton>}
              </div>
              {c.backend === "sputnik" && relayerEnabled() && !!signer && <GaslessVote dao={DAO_ACCOUNT} proposalId={Number(c.ref)} kind={kind} rpcUrl={NEAR_RPC_URL} paymentId={p.id} />}
            </div>
          )}
          {p.status === "ready_to_send" && !!signer && <div className="mt-4"><ActionButton url={`/api/payments/${p.id}/settlement`} variant="secondary">Check delivery (1Click)</ActionButton></div>}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card" style={{ borderColor: "var(--bd-sage)" }}>
          <div className="flex items-center justify-between">
            <h2>Verified</h2>
            <Badge tone={v.signature.valid ? "ok" : "bad"}>{v.signature.valid ? "Signature checks out" : "Signature failed"}</Badge>
          </div>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-2)" }}>Exactly what was checked on this payment.</p>
          <ul className="mt-2">
            <Row ok={v.attestation.nonceBound} label="Fresh attestation (nonce)">
              <span className="mono">{short(v.attestation.nonce, 12)}</span> · {v.attestation.nonce ? aiSource : "AI review did not run"}
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
            <Row ok={c ? true : null} label="Evidence anchored onchain">
              {c ? `Evidence hash ${c.evidenceHash.slice(0, 16)}… is in the ${c.backend === "sputnik" ? "DAO proposal description" : "ft_transfer memo"}, so the payout and this record point at each other.` : CUSTODY === "manual" ? "Manual custody: no onchain anchor." : "Anchored when the payout is handed to the treasury."}
            </Row>
            <Row ok={!v.zkProof || v.zkProof.status === "pending" ? null : v.zkProof.status === "verified"} label="Zero-knowledge proof of the policy check (o1js)">
              {v.zkProof ? v.zkProof.note : "Not recorded for this payment."}{v.zkProof?.proverSeconds ? ` Proved in ${v.zkProof.proverSeconds}s.` : ""}
            </Row>
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
                Sent to <span className="mono">{p.callback.handle}</span> on {p.callback.channel} ({p.callback.delivered === "telegram" ? "delivered on Telegram" : p.callback.delivered === "voice" ? "voice call placed" : p.callback.delivered === "demo" ? "demo mode: nothing was sent; record the answer below" : "not automated: contact the vendor yourself and record the answer below"}), a channel we already had on file, not the one in the invoice.
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
              {p.quote && (<><dt style={{ color: "var(--tx-2)" }}>Quote</dt><dd className="mono">{p.quote.amountIn} → {p.quote.amountOut} ({p.quote.source === "demo-fixture" ? "demo quote" : p.quote.source === "1click-dry" ? "1Click dry-run" : "1Click, mainnet"})</dd></>)}
              {p.txRef && (<><dt style={{ color: "var(--tx-2)" }}>Reference</dt><dd className="mono">{p.txRef}</dd></>)}
            </dl>
            <p className="mt-3 text-sm" style={{ color: "var(--tx-2)" }}>Bluvfi Business stops money before it leaves. Funds already settled on another chain cannot be frozen.</p>
          </section>
        </div>
      </div>

      <section className="card mt-4">
        <h2>What the model saw</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{p.redactedBy === "near-ai+local-regex" ? "Names, contact and bank details were stripped by NEAR AI Cloud’s privacy filter (inside its TEE), then wallets and handles by local patterns, before any reasoning call." : "Contact details, bank details and wallets were stripped by local patterns before any reasoning call (patterns can miss names)."} The original invoice text:</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div><div className="label mb-1">Original (stays on this server)</div><pre className="mono overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{p.invoice.text.replace(/​/g, "␣")}</pre></div>
          <div><div className="label mb-1">Sent to the private model</div><pre className="mono overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>{p.redactedInput.replace(/​/g, "␣")}</pre></div>
        </div>
        <p className="mono mt-3 break-all text-xs" style={{ color: "var(--tx-2)" }}>record {p.recordHash} · previous {short(p.prevHash, 12)} · {when(p.createdAt)}</p>
      </section>
    </>
  );
}
