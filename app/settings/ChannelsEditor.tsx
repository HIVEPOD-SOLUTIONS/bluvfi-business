"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";

type CardStatus = {
  fromEnv: boolean; provider: string; asked: string; stripe: boolean; stripeCardholder: string; stripeWebhook: boolean; stripeTest: boolean;
  ramp: boolean; rampClientId: string; rampUserId: string; rampSandbox: boolean; rain: boolean; rainUserId: string; rainBaseUrl: string; rainPublicKey: boolean;
};
type Status = { cronSecret: string; telegram: boolean; twilio: boolean; twilioSid: string; twilioFrom: string; agentMarket: boolean; pingpay: boolean; x402FacilitatorUrl: string; credible: boolean; backpack: boolean; cards: CardStatus };

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
        <button type="button" className="btn btn-ghost" disabled={loading} aria-busy={loading} onClick={() => window.confirm("Disconnect this? The business stops using it.") && void send(clear)}>Disconnect</button>
      </div>
      <ErrorLine msg={error} />
      {note && <p className="text-sm pos">{note}</p>}
    </form>
  );
}

const Field = ({ label, value, set, type = "text", ph }: { label: string; value: string; set: (v: string) => void; type?: string; ph?: string }) => (
  <label className="block"><span className="label">{label}</span><input className="input mt-1" type={type} autoComplete="off" placeholder={ph} value={value} onChange={(e) => set(e.target.value)} /></label>
);

export function ChannelsEditor({ owner, status, urls }: { owner: boolean; status: Status; urls: { check: string; ledger: string; poll: string; stripeCards: string } }) {
  const [tg, setTg] = useState("");
  const [sid, setSid] = useState(status.twilioSid);
  const [tok, setTok] = useState("");
  const [from, setFrom] = useState(status.twilioFrom);
  const [am, setAm] = useState("");
  const [pp, setPp] = useState("");
  const [fac, setFac] = useState(status.x402FacilitatorUrl);
  const [crKey, setCrKey] = useState("");
  const [crSecret, setCrSecret] = useState("");
  const [bpKey, setBpKey] = useState("");
  const [bpSecret, setBpSecret] = useState("");
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
      <Section title="Bank transfers (Credible Finance)" on={status.credible} hint="Your own Credible Finance account, for adding money by UPI and cashing out to an Indian bank account in rupees. Credible only answers from IP addresses you have allowed in its dashboard: allow this server&apos;s. Bank account numbers go straight to Credible and are never kept here.">
        {status.cards.fromEnv ? <p className="text-sm" style={{ color: "var(--tx-2)" }}>This is the platform operator&apos;s own business: its Credible keys are set in .env.local (CREDIBLE_FINANCE_API_KEY and CREDIBLE_FINANCE_API_SECRET), not here.</p> : (
          <Form owner={owner} fields={{ credibleKey: crKey, credibleSecret: crSecret }} clear={{ credibleKey: "", credibleSecret: "" }}>
            <Field label="API key" type="password" value={crKey} set={setCrKey} ph={status.credible ? "Set. Paste a new one to replace it." : ""} />
            <Field label="API secret" type="password" value={crSecret} set={setCrSecret} ph={status.credible ? "Set. Paste a new one to replace it." : ""} />
          </Form>
        )}
      </Section>
      <Section title="Stocks (Backpack Exchange)" on={status.backpack} hint="Your own Backpack account, for US stocks and ETFs. Create an API key at backpack.exchange/settings/api-keys. The treasury pays USDC to your account's deposit address as a normal approved payment; trades use this key and are capped by your policy. Withdrawals are not made from here.">
        {status.cards.fromEnv ? <p className="text-sm" style={{ color: "var(--tx-2)" }}>This is the platform operator&apos;s own business: its Backpack keys are set in .env.local (BACKPACK_API_KEY and BACKPACK_API_SECRET), not here.</p> : (
          <Form owner={owner} fields={{ backpackKey: bpKey, backpackSecret: bpSecret }} clear={{ backpackKey: "", backpackSecret: "" }}>
            <Field label="API key" type="password" value={bpKey} set={setBpKey} ph={status.backpack ? "Set. Paste a new one to replace it." : ""} />
            <Field label="API secret" type="password" value={bpSecret} set={setBpSecret} ph={status.backpack ? "Set. Paste a new one to replace it." : ""} />
          </Form>
        )}
      </Section>
      <CardsSection owner={owner} c={status.cards} webhook={urls.stripeCards} />
    </div>
  );
}

const PROVIDER_NAME: Record<string, string> = { stripe: "Stripe Issuing", ramp: "Ramp Agent Cards", rain: "Rain" };

/**
 * The business's own card-issuing account, for the agent's one-time cards. Cards are charged to this account and no other business's.
 * One provider is used; the select says which when more than one is set.
 */
function CardsSection({ owner, c, webhook }: { owner: boolean; c: CardStatus; webhook: string }) {
  const [provider, setProvider] = useState(c.asked || c.provider || "stripe");
  const [sk, setSk] = useState("");
  const [holder, setHolder] = useState(c.stripeCardholder);
  const [whsec, setWhsec] = useState("");
  const [rampId, setRampId] = useState(c.rampClientId);
  const [rampSecret, setRampSecret] = useState("");
  const [rampUser, setRampUser] = useState(c.rampUserId);
  const [rampSandbox, setRampSandbox] = useState(c.rampSandbox);
  const [rainKey, setRainKey] = useState("");
  const [rainUser, setRainUser] = useState(c.rainUserId);
  const [rainPem, setRainPem] = useState("");
  const [rainBase, setRainBase] = useState(c.rainBaseUrl);
  const hint = `One-time cards for the agent come from this business's own card-issuing account, so every card is charged to it and to no other business. ${
    c.provider ? `In use: ${PROVIDER_NAME[c.provider]}${c.provider === "stripe" && c.stripeTest ? " (test mode)" : ""}.` : "Connect one provider."
  }`;
  if (c.fromEnv) {
    return (
      <Section title="Cards" on={!!c.provider} hint={hint}>
        <p className="text-sm" style={{ color: "var(--tx-2)" }}>This is the platform operator&apos;s own business: its card keys are set in .env.local (STRIPE_*, RAMP_* or RAIN_*), not here.</p>
        {c.provider === "stripe" && <p className="text-sm">Stripe authorization webhook: <span className="mono break-all">{webhook}</span> {c.stripeWebhook ? "" : "(no signing secret set: charges are not approved here)"}</p>}
      </Section>
    );
  }
  const fields: Record<string, string> =
    provider === "stripe" ? { cardProvider: "stripe", stripeKey: sk, stripeCardholder: holder, stripeWebhookSecret: whsec }
    : provider === "ramp" ? { cardProvider: "ramp", rampClientId: rampId, rampClientSecret: rampSecret, rampUserId: rampUser, rampSandbox: rampSandbox ? "1" : "0" }
    : { cardProvider: "rain", rainKey, rainUserId: rainUser, rainPublicKey: rainPem, rainBaseUrl: rainBase };
  const clear: Record<string, string> =
    provider === "stripe" ? { stripeKey: "", stripeCardholder: "", stripeWebhookSecret: "" }
    : provider === "ramp" ? { rampClientId: "", rampClientSecret: "", rampUserId: "", rampSandbox: "" }
    : { rainKey: "", rainUserId: "", rainPublicKey: "", rainBaseUrl: "" };
  const setMark = (on: boolean) => (on ? "Set. Paste a new one to replace it." : "");
  return (
    <Section title="Cards" on={!!c.provider} hint={hint}>
      <label className="block"><span className="label">Provider</span>
        <select className="input mt-1" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!owner}>
          <option value="stripe">Stripe Issuing {c.stripe ? "(set)" : ""}</option>
          <option value="ramp">Ramp Agent Cards {c.ramp ? "(set)" : ""}</option>
          <option value="rain">Rain, backed by stablecoins {c.rain ? "(set)" : ""}</option>
        </select>
      </label>
      <Form owner={owner} fields={fields} clear={clear}>
        {provider === "stripe" && (
          <>
            <Field label="Secret key" type="password" value={sk} set={setSk} ph={setMark(c.stripe) || "sk_test_… (test mode is free)"} />
            <Field label="Company cardholder id" value={holder} set={setHolder} ph="ich_…" />
            <Field label="Authorization webhook signing secret" type="password" value={whsec} set={setWhsec} ph={setMark(c.stripeWebhook) || "whsec_…"} />
            <p className="text-xs" style={{ color: "var(--tx-2)" }}>In Stripe, point Issuing&apos;s real-time authorization webhook at <span className="mono break-all">{webhook}</span>. Every charge on this business&apos;s cards is then approved or declined here, against the purchase the card was made for.</p>
          </>
        )}
        {provider === "ramp" && (
          <>
            <Field label="Client id" value={rampId} set={setRampId} />
            <Field label="Client secret" type="password" value={rampSecret} set={setRampSecret} ph={setMark(c.ramp)} />
            <Field label="User whose funds the cards draw on" value={rampUser} set={setRampUser} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rampSandbox} onChange={(e) => setRampSandbox(e.target.checked)} /> Ramp&apos;s sandbox (no real money)</label>
          </>
        )}
        {provider === "rain" && (
          <>
            <Field label="API key" type="password" value={rainKey} set={setRainKey} ph={setMark(c.rain)} />
            <Field label="User id" value={rainUser} set={setRainUser} />
            <label className="block"><span className="label">Rain&apos;s public key (PEM), for reading card numbers</span>
              <textarea className="input mt-1 mono text-xs" rows={4} value={rainPem} onChange={(e) => setRainPem(e.target.value)} placeholder={c.rainPublicKey ? "Set. Paste a new key to replace it." : "-----BEGIN PUBLIC KEY-----"} /></label>
            <Field label="API address (empty: Rain's production)" value={rainBase} set={setRainBase} ph="https://api-dev.raincards.xyz/v1 for the sandbox" />
          </>
        )}
      </Form>
    </Section>
  );
}
