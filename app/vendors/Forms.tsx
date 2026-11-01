"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";

const EMPTY = { name: "", domain: "", channel: "email", handle: "", chain: "near", asset: "USDC", address: "", allow: true };

export function NewVendor() {
  const { run, error, loading } = useAction();
  const [f, setF] = useState(EMPTY);
  const text = (k: keyof typeof EMPTY, label: string, placeholder = "") => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input mt-1" required value={String(f[k])} placeholder={placeholder} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <form
      className="card grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run("/api/vendors", {
          proposeAllowlist: f.allow,
          vendor: {
            name: f.name, domain: f.domain, verifiedContact: { channel: f.channel, handle: f.handle },
            payout: { chain: f.chain, asset: f.asset, address: f.address },
          },
        });
        if (ok) setF(EMPTY);
      }}
    >
      <h2 className="sm:col-span-2">Add or update a vendor</h2>
      {text("name", "Legal name", "Northwind Cloud Ltd")}
      {text("domain", "Domain", "northwind.io")}
      <label className="block">
        <span className="label">Verified channel</span>
        <select className="input mt-1" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
          <option value="telegram">Telegram (vendor chat id with the bot)</option>
          <option value="voice">Voice call (phone number, E.164)</option>
          <option value="email">Email (a person confirms by hand)</option>
        </select>
      </label>
      {text("handle", "Channel handle", f.channel === "voice" ? "+14155550134" : f.channel === "telegram" ? "123456789" : "billing@northwind.io")}
      <label className="block">
        <span className="label">Pays on</span>
        <select className="input mt-1" value={f.chain} onChange={(e) => setF({ ...f, chain: e.target.value })}>
          {["near", "eth", "base", "arb", "sol"].map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="label">Asset</span>
        <select className="input mt-1" value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}>
          {["USDC", "USDT"].map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <div className="sm:col-span-2">{text("address", "Payout address", "northwind.near")}</div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={f.allow} onChange={(e) => setF({ ...f, allow: e.target.checked })} />
        Also propose adding this vendor to the policy allowlist (other signers must approve)
      </label>
      <p className="text-sm sm:col-span-2" style={{ color: "var(--tx-2)" }}>
        Confirm the verified channel yourself, out of band. It is the only place the agent will ask “was this really you?” when payout details change.
      </p>
      <div className="sm:col-span-2"><button className="btn btn-primary" disabled={loading}>{loading ? "Saving…" : "Save vendor"}</button><ErrorLine msg={error} /></div>
    </form>
  );
}

export function NewPurchaseOrder({ vendors }: { vendors: string[] }) {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({ po: "", vendorName: "", amountUsd: "" });
  return (
    <form
      className="card grid gap-3 sm:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run("/api/vendors", { purchaseOrder: { po: f.po, vendorName: f.vendorName, amountUsd: Number(f.amountUsd) } });
        if (ok) setF({ po: "", vendorName: "", amountUsd: "" });
      }}
    >
      <label className="block"><span className="label">PO number</span>
        <input className="input mt-1" required value={f.po} onChange={(e) => setF({ ...f, po: e.target.value })} /></label>
      <label className="block"><span className="label">Vendor</span>
        <select className="input mt-1" required value={f.vendorName} onChange={(e) => setF({ ...f, vendorName: e.target.value })}>
          <option value="" disabled>Choose…</option>
          {vendors.map((v) => <option key={v}>{v}</option>)}
        </select></label>
      <label className="block"><span className="label">Amount (USD)</span>
        <input className="input mt-1" required type="number" min="0.01" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} /></label>
      <div className="flex items-end"><button className="btn btn-secondary" disabled={loading || vendors.length === 0}>Save PO</button></div>
      <div className="sm:col-span-4"><ErrorLine msg={error} /></div>
    </form>
  );
}
