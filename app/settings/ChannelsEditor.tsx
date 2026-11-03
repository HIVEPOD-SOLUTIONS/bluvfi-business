"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";

type Status = { cronSecret: string; telegram: boolean; twilio: boolean; twilioSid: string; twilioFrom: string; agentMarket: boolean; pingpay: boolean; x402FacilitatorUrl: string };

function Section({ title, on, hint, children }: { title: string; on: boolean; hint: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2>{title}</h2><Badge tone={on ? "ok" : "default"}>{on ? "Connected" : "Not set"}</Badge></div>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{hint}</p>
      <div className="mt-3 grid gap-3">{children}</div>
    </section>
  );
}

/** Owners save one section at a time; a field left empty is kept, and Disconnect clears the section. Secrets are never shown again. */
function Form({ owner, fields, clear, children }: { owner: boolean; fields: Record<string, string>; clear: Record<string, string>; children: React.ReactNode }) {
  const { run, error, loading } = useAction();
  const [note, setNote] = useState<string | null>(null);
  const send = async (payload: Record<string, string>) => {
    setNote(null);
    const out = await run<{ notes?: string[] }>("/api/channels", payload);
    if (out) setNote(out.notes?.join(" ") || "Saved.");
  };
  if (!owner) return <p className="text-sm" style={{ color: "var(--tx-2)" }}>Only an owner can change this.</p>;
  const filled = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()));
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void send(filled); }}>
      {children}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={loading || !Object.keys(filled).length}>{loading ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => window.confirm("Disconnect this? The business stops using it.") && void send(clear)}>Disconnect</button>
      </div>
      <ErrorLine msg={error} />
      {note && <p className="text-sm pos">{note}</p>}
    </form>
  );
}

const Field = ({ label, value, set, type = "text", ph }: { label: string; value: string; set: (v: string) => void; type?: string; ph?: string }) => (
  <label className="block"><span className="label">{label}</span><input className="input mt-1" type={type} autoComplete="off" placeholder={ph} value={value} onChange={(e) => set(e.target.value)} /></label>
);

export function ChannelsEditor({ owner, status, urls }: { owner: boolean; status: Status; urls: { check: string; ledger: string; poll: string } }) {
  const [tg, setTg] = useState("");
  const [sid, setSid] = useState(status.twilioSid);
  const [tok, setTok] = useState("");
  const [from, setFrom] = useState(status.twilioFrom);
  const [am, setAm] = useState("");
  const [pp, setPp] = useState("");
  const [fac, setFac] = useState(status.x402FacilitatorUrl);
  return (
    <div className="grid gap-4">
      <Section title="Telegram" on={status.telegram} hint="Your own bot (create one with @BotFather). Vendors reply YES or NO to payment-detail callbacks, and the reply reaches only this business. We register the webhook for you.">
        <Form owner={owner} fields={{ telegramBotToken: tg }} clear={{ telegramBotToken: "" }}>
          <Field label="Bot token" type="password" value={tg} set={setTg} ph={status.telegram ? "Set. Paste a new token to replace it." : "123456789:AA…"} />
        </Form>
      </Section>
      <Section title="Voice calls (Twilio)" on={status.twilio} hint="Your own Twilio account and number. The agent phones a vendor's verified number to confirm changed payment details.">
        <Form owner={owner} fields={{ twilioSid: sid, twilioToken: tok, twilioFrom: from }} clear={{ twilioSid: "", twilioToken: "", twilioFrom: "" }}>
          <Field label="Account SID" value={sid} set={setSid} ph="AC…" />
          <Field label="Auth token" type="password" value={tok} set={setTok} ph={status.twilio ? "Set. Paste a new token to replace it." : ""} />
          <Field label="Number to call from" value={from} set={setFrom} ph="+15551234567" />
        </Form>
      </Section>
      <Section title="Agent Market" on={status.agentMarket} hint={`Your own worker token (aat_…) from market.near.ai. To poll on a schedule, POST ${urls.poll} with the header Authorization: Bearer <your cron secret>, or press Poll on the Check page.`}>
        {status.cronSecret && <p className="text-sm">Cron secret: <span className="mono">{status.cronSecret}</span></p>}
        <Form owner={owner} fields={{ agentMarketToken: am }} clear={{ agentMarketToken: "" }}>
          <Field label="Worker token" type="password" value={am} set={setAm} ph={status.agentMarket ? "Set. Paste a new token to replace it." : "aat_…"} />
        </Form>
      </Section>
      <Section title="Check: what you earn" on={status.pingpay || !!status.x402FacilitatorUrl} hint={`Other agents pay this business per check over x402 at ${urls.check}, and it settles to this business's own treasury. Use your own PingPay key, or an x402 facilitator that supports NEAR (it pays your treasury directly). The free ledger of your payments, if you publish it, is at ${urls.ledger}.`}>
        <Form owner={owner} fields={{ pingpayKey: pp, x402FacilitatorUrl: fac }} clear={{ pingpayKey: "", x402FacilitatorUrl: "" }}>
          <Field label="PingPay API key" type="password" value={pp} set={setPp} ph={status.pingpay ? "Set. Paste a new key to replace it." : ""} />
          <Field label="Or an x402 facilitator URL (https)" value={fac} set={setFac} ph="https://…" />
        </Form>
      </Section>
    </div>
  );
}
