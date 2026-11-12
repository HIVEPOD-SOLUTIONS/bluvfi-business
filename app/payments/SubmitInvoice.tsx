"use client";
import { useState } from "react";
import { ErrorLine, useAction } from "@/components/Actions";
import type { PayoutRoute } from "@/lib/intents-tokens";

interface VendorOption { name: string; domain: string; chain: string; asset: string; address: string }

export function SubmitInvoice({ vendors, routes }: { vendors: VendorOption[]; routes: PayoutRoute[] }) {
  const { run, error, loading } = useAction();
  const [f, setF] = useState({
    vendorName: "", vendorDomain: "", invoiceNumber: "", poNumber: "", amountUsd: "", chain: "near",
    asset: "USDC", payoutAddress: "", text: "", confidentiality: "basic",
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const field = (k: keyof typeof f, label: string, type = "text", extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input mt-1" type={type} value={f[k]} onChange={set(k)} {...extra} />
    </label>
  );
  return (
    <section className="card mt-8">
      <h2>Submit an invoice to the agent</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
        Paste what the vendor sent. The details are compared with the vendor record, so a changed payout address or a hidden instruction is caught.
      </p>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          run("/api/invoices", {
            confidentiality: f.confidentiality,
            invoice: {
              vendorName: f.vendorName, vendorDomain: f.vendorDomain, invoiceNumber: f.invoiceNumber, poNumber: f.poNumber,
              amountUsd: Number(f.amountUsd), asset: f.asset, chain: f.chain, payoutAddress: f.payoutAddress, text: f.text,
            },
          });
        }}
      >
        <label className="block">
          <span className="label">Vendor</span>
          <input
            className="input mt-1" required list="vendor-options" value={f.vendorName}
            onChange={(e) => {
              const v = vendors.find((x) => x.name === e.target.value);
              setF(v ? { ...f, vendorName: v.name, vendorDomain: v.domain, chain: v.chain, asset: v.asset, payoutAddress: v.address } : { ...f, vendorName: e.target.value });
            }}
          />
          <datalist id="vendor-options">{vendors.map((v) => <option key={v.name} value={v.name} />)}</datalist>
        </label>
        {field("vendorDomain", "Domain the invoice came from")}
        {field("invoiceNumber", "Invoice number", "text", { required: true })}
        {field("poNumber", "Purchase order")}
        {field("amountUsd", "Amount (USD)", "number", { required: true, min: "0.01", step: "0.01" })}
        <label className="block">
          <span className="label">Chain</span>
          <select className="input mt-1" value={f.chain} onChange={(e) => { const c = e.target.value; const a = routes.find((r) => r.chain === c)?.assets ?? []; setF({ ...f, chain: c, asset: a.includes(f.asset) ? f.asset : a[0] ?? "USDC" }); }}>
            {routes.map((r) => <option key={r.chain} value={r.chain}>{r.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Asset</span>
          <select className="input mt-1" value={f.asset} onChange={set("asset")}>
            {(routes.find((r) => r.chain === f.chain)?.assets ?? []).map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <div className="sm:col-span-2">{field("payoutAddress", "Payout address on the invoice", "text", { required: true })}</div>
        <label className="block sm:col-span-2">
          <span className="label">Invoice text, exactly as received</span>
          <textarea className="input mt-1" required value={f.text} onChange={set("text")} />
        </label>
        <label className="block">
          <span className="label">Privacy for this payment</span>
          <select className="input mt-1" value={f.confidentiality} onChange={set("confidentiality")}>
            <option value="public">public</option>
            <option value="basic">basic</option>
            <option value="advanced">advanced</option>
          </select>
        </label>
        <div className="flex items-end">
          <button className="btn btn-primary" disabled={loading} aria-busy={loading}>{loading ? "Reviewing…" : "Send to agent"}</button>
        </div>
      </form>
      <ErrorLine msg={error} />
    </section>
  );
}
