"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/Toast";
import type { Block, Msg, Pending, Turn } from "@/lib/agent-chat";
import type { CardSecrets } from "@/lib/card-providers";

// A one-time card's number lives only in this component's memory, for this one showing, until hidden. It is never stored anywhere.
interface Entry { role: "user" | "assistant"; text: string; blocks?: Block[]; pending?: Pending; done?: { message: string; href?: string; card?: CardSecrets } | "cancelled"; error?: string }

const IDEAS = ["What is the price of NEAR?", "What does the treasury hold?", "Show my payments this month", "Find a Netflix gift card", "Invest $200 in ETH", "Put $500 into the treasury", "Get a card to buy a $15 domain"];

/** A conversation. Anything the agent found is shown as a table; anything that would spend waits on a card for you to confirm or cancel. */
export function ChatPanel() {
  const [log, setLog] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [log, busy]);

  const history = (): Msg[] => log.filter((e) => e.text).map((e) => ({ role: e.role, content: e.text }));

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    const past = history();
    setLog((l) => [...l, { role: "user", text: m }]);
    setText(""); setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: m, history: past }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setLog((l) => [...l, { role: "assistant", text: "", error: json.error ?? `Something went wrong (${res.status}).` }]);
      else { const t = json as Turn; setLog((l) => [...l, { role: "assistant", text: t.reply, blocks: t.blocks, pending: t.pending }]); }
    } catch { setLog((l) => [...l, { role: "assistant", text: "", error: "Could not reach the server." }]); } finally { setBusy(false); }
  }

  async function confirm(i: number, p: Pending) {
    setBusy(true);
    try {
      const res = await fetch("/api/chat/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p.id }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setLog((l) => l.map((e, k) => (k === i ? { ...e, error: json.error ?? "That did not work." } : e))); return; }
      toast(json.card ? "Card ready: copy it now" : "Done: now it needs approval");
      setLog((l) => l.map((e, k) => (k === i ? { ...e, pending: undefined, done: json } : e)));
    } catch { setLog((l) => l.map((e, k) => (k === i ? { ...e, error: "Could not reach the server." } : e))); } finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-col gap-3" style={{ minHeight: 420 }}>
      <div className="flex flex-col gap-3" aria-live="polite">
        {log.length === 0 && (
          <div>
            <p style={{ color: "var(--tx-1)" }}>Try one of these, or write your own:</p>
            <div className="mt-2 flex flex-wrap gap-2">{IDEAS.map((q) => <button key={q} className="btn btn-ghost btn-sm" onClick={() => send(q)}>{q}</button>)}</div>
          </div>
        )}
        {log.map((e, i) => (
          <div key={i} className={`reveal flex ${e.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[92%] rounded-2xl px-4 py-3" style={{ background: e.role === "user" ? "rgba(10,10,232,.2)" : "var(--bg-2)", border: "1px solid var(--bd)" }}>
              {e.text && <p>{e.text}</p>}
              {e.error && <p role="alert" className="shake neg">{e.error}</p>}
              {e.blocks?.map((b, k) => (
                <div key={k} className="mt-2 overflow-x-auto">
                  {b.title && <div className="label mb-1">{b.title}</div>}
                  {b.columns && b.rows && (
                    <table className="t text-sm"><thead><tr className="label">{b.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                      <tbody>{b.rows.map((r, n) => <tr key={n}>{r.map((c, x) => <td key={x}>{c}</td>)}</tr>)}</tbody></table>
                  )}
                </div>
              ))}
              {e.pending && (
                <div className="mt-3 rounded-xl p-3" style={{ border: "1px solid rgba(10,10,232,.5)", background: "rgba(10,10,232,.08)" }}>
                  <div className="label">Waiting for you</div>
                  <strong className="block mt-1">{e.pending.summary}</strong>
                  <ul className="mt-1 list-disc pl-5 text-sm" style={{ color: "var(--tx-1)" }}>{e.pending.detail.map((d) => <li key={d}>{d}</li>)}</ul>
                  <div className="mt-3 flex gap-2">
                    <button className="btn btn-primary btn-sm" disabled={busy} aria-busy={busy} onClick={() => confirm(i, e.pending!)}>Confirm</button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setLog((l) => l.map((x, k) => (k === i ? { ...x, pending: undefined, done: "cancelled" } : x)))}>Cancel</button>
                  </div>
                </div>
              )}
              {e.done === "cancelled" && <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>Cancelled. Nothing was done.</p>}
              {e.done && e.done !== "cancelled" && <p className="mt-2 text-sm pos">{e.done.message} {e.done.href && <Link className="underline" href={e.done.href}>Open it →</Link>}</p>}
              {e.done && e.done !== "cancelled" && e.done.card && (
                <div className="mt-2 rounded-xl p-3" style={{ border: "1px solid rgba(10,10,232,.5)" }} aria-live="polite">
                  <dl className="grid gap-1 mono text-sm">
                    <div>Number: <span className="select-all">{e.done.card.number}</span></div>
                    <div>Expires: {e.done.card.expiry} · CVC: <span className="select-all">{e.done.card.cvc}</span></div>
                  </dl>
                  <p className="mt-2 text-xs" style={{ color: "var(--tx-2)" }}>Shown once and stored nowhere: copy it into the checkout now. It works only for this purchase, up to its amount.</p>
                  <button className="btn btn-secondary btn-sm mt-2" onClick={() => setLog((l) => l.map((x, k) => (k === i && x.done && x.done !== "cancelled" ? { ...x, done: { message: x.done.message, href: x.done.href } } : x)))}>Hide it now</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="rounded-2xl px-4 py-3" style={{ background: "var(--bg-2)", border: "1px solid var(--bd)" }}><span className="live-dot inline-block" aria-hidden /> <span className="text-sm" style={{ color: "var(--tx-2)" }}>Working on it…</span></div></div>}
        <div ref={end} />
      </div>
      <form className="mt-auto flex gap-2" onSubmit={(ev) => { ev.preventDefault(); void send(text); }}>
        <input className="input" placeholder="Ask or tell the agent what to do…" value={text} maxLength={800} onChange={(e) => setText(e.target.value)} aria-label="Message to the agent" />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
