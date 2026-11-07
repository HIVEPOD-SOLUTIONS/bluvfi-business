"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorLine, useAction } from "@/components/Actions";
import { Badge } from "@/components/ui";
import type { BillProduct, BillProductDetails } from "@/lib/bills";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Minutes and seconds left, counting down: an order's price only holds for a short while. */
export function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Date.parse(until) - now);
  const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
  return <span className="mono" style={{ color: left < 3 * 60_000 ? "var(--red-alert)" : "var(--amber)" }}>{left === 0 ? "price expired" : `${m}:${String(s).padStart(2, "0")} left`}</span>;
}

/** Two places to buy from: pick one. Either way the order becomes a payment that your rules and your treasury still decide. */
export function BillsPanel({ cryptorefillsOn }: { cryptorefillsOn: boolean }) {
  const [provider, setProvider] = useState<"bitrefill" | "cryptorefills">("bitrefill");
  return (
    <div>
      <div className="mb-3 flex gap-2" role="tablist" aria-label="Where to buy from">
        {(["bitrefill", "cryptorefills"] as const).map((p) => (
          <button key={p} role="tab" aria-selected={provider === p} className={`btn btn-sm ${provider === p ? "btn-primary" : "btn-ghost"}`} onClick={() => setProvider(p)}>{p === "bitrefill" ? "Bitrefill" : "Cryptorefills"}</button>
        ))}
      </div>
      {provider === "bitrefill" ? <BitrefillPanel /> : <CryptorefillsPanel configured={cryptorefillsOn} />}
    </div>
  );
}

/** Cryptorefills: pick a country and a brand, then a product, say who it is for, and order. */
function CryptorefillsPanel({ configured }: { configured: boolean }) {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const [country, setCountry] = useState("US");
  const [q, setQ] = useState("");
  const [brands, setBrands] = useState<{ name: string; category: string }[] | null>(null);
  const [brand, setBrand] = useState("");
  const [products, setProducts] = useState<{ productId: string; label: string; currency: string; isRange: boolean; priceUsd: number | null; min?: number; max?: number }[] | null>(null);
  const [pick, setPick] = useState("");
  const [value, setValue] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function get<T>(url: string): Promise<T | null> {
    setBusy(true); setErr("");
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error ?? `Something went wrong (${res.status}).`); return null; }
      return json as T;
    } catch { setErr("Could not reach the server."); return null; } finally { setBusy(false); }
  }
  const chosen = products?.find((p) => p.productId === pick);

  return (
    <div className="grid gap-4">
      {!configured && <p className="card text-sm" style={{ color: "var(--amber)" }}>Cryptorefills orders need a CRYPTOREFILLS_PARTNER_ID (free with any Cryptorefills account). You can still look around.</p>}
      <div className="card">
        <h2>1 · Find a brand</h2>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); setProducts(null); setBrand(""); const r = await get<{ brands: { name: string; category: string }[] }>(`/api/bills?provider=cryptorefills&country=${encodeURIComponent(country)}&q=${encodeURIComponent(q)}`); if (r) setBrands(r.brands); }}>
          <input className="input max-w-sm" placeholder="Amazon, Netflix, a phone network…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Brand" />
          <input className="input w-24" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} aria-label="Two-letter country code" />
          <button className="btn btn-primary" disabled={busy || country.length !== 2} aria-busy={busy}>Search</button>
        </form>
        {brands && brands.length === 0 && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>No brand found. Try another word or country.</p>}
        {brands && brands.length > 0 && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {brands.map((b) => (
              <li key={b.name}><button className="card w-full text-left" style={{ padding: 14 }} onClick={async () => { setBrand(b.name); setPick(""); const r = await get<{ products: NonNullable<typeof products> }>(`/api/bills?provider=cryptorefills&country=${encodeURIComponent(country)}&brand=${encodeURIComponent(b.name)}`); if (r) { setProducts(r.products); setPick(r.products[0]?.productId ?? ""); } }}>
                <strong>{b.name}</strong><div className="text-xs" style={{ color: "var(--tx-2)" }}>{b.category}</div></button></li>
            ))}
          </ul>
        )}
        <ErrorLine msg={err} />
      </div>
      {brand && products && (
        <div className="card reveal">
          <h2>2 · {brand}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">Product</span>
              <select className="input mt-1" value={pick} onChange={(e) => setPick(e.target.value)}>
                {products.map((p) => <option key={p.productId} value={p.productId}>{p.label}{p.priceUsd ? ` · about ${usd(p.priceUsd)}` : ""}</option>)}
              </select></label>
            {chosen?.isRange && (
              <label className="block"><span className="label">Amount ({chosen.min} to {chosen.max} {chosen.currency})</span>
                <input className="input mt-1" type="number" min={chosen.min} max={chosen.max} value={value} onChange={(e) => setValue(e.target.value)} /></label>
            )}
            <label className="block"><span className="label">Who it is for (email or phone number)</span>
              <input className="input mt-1" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} /></label>
            <label className="block"><span className="label">Email for the receipt and the code</span>
              <input className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          </div>
          <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Ordering does not spend anything yet. It makes a payment that goes through your rules and your treasury&apos;s approval, like any invoice, and Cryptorefills holds the order for a limited time.</p>
          <button className="btn btn-primary mt-3" disabled={loading || !configured || !chosen || !email.includes("@") || !beneficiary.trim() || (!!chosen.isRange && !value)} aria-busy={loading} onClick={async () => {
            const r = await run<{ payment: { id: string } }>("/api/bills", { provider: "cryptorefills", country, brand, productId: pick, productValue: chosen?.isRange ? Number(value) : undefined, beneficiary, email }, "POST", "Order made: now it needs approval");
            if (r) router.push(`/payments/${r.payment.id}`);
          }}>Order it</button>
          <ErrorLine msg={error} />
        </div>
      )}
    </div>
  );
}

/** Find a gift card, top-up or eSIM, choose a size, and order it. The order becomes a payment that your rules and your treasury still decide. */
function BitrefillPanel() {
  const { run, error, loading } = useAction();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [results, setResults] = useState<BillProduct[] | null>(null);
  const [product, setProduct] = useState<BillProductDetails | null>(null);
  const [size, setSize] = useState("");
  const [email, setEmail] = useState("");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function get<T>(url: string): Promise<T | null> {
    setBusy(true); setErr("");
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error ?? `Something went wrong (${res.status}).`); return null; }
      return json as T;
    } catch { setErr("Could not reach the server."); return null; } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4">
      <div className="card">
        <h2>1 · Find what you need</h2>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); setProduct(null); const r = await get<{ products: BillProduct[] }>(`/api/bills?q=${encodeURIComponent(q)}${country ? `&country=${encodeURIComponent(country)}` : ""}`); if (r) setResults(r.products); }}>
          <input className="input max-w-sm" placeholder="Amazon, Netflix, a phone network, an eSIM…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="What to buy" />
          <input className="input w-24" placeholder="Country" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} aria-label="Two-letter country code" />
          <button className="btn btn-primary" disabled={busy || q.trim().length < 2} aria-busy={busy}>Search</button>
        </form>
        {results && results.length === 0 && <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Nothing found. Try another word, or a country code like US or NG.</p>}
        {results && results.length > 0 && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {results.map((p) => (
              <li key={p.id}>
                <button className="card w-full text-left" style={{ padding: 14 }} onClick={async () => { const r = await get<{ product: BillProductDetails }>(`/api/bills?product=${encodeURIComponent(p.id)}`); if (r) { setProduct(r.product); setSize(r.product.packages[0]?.value ?? ""); } }}>
                  <div className="flex items-center justify-between gap-2"><strong>{p.name}</strong>{!p.inStock && <Badge tone="warn">Out of stock</Badge>}</div>
                  <div className="text-xs" style={{ color: "var(--tx-2)" }}>{p.type} · {p.countries.slice(0, 6).join(", ")}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorLine msg={err} />
      </div>

      {product && (
        <div className="card reveal">
          <h2>2 · {product.name}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {product.packages.length > 0 ? (
              <label className="block"><span className="label">Size</span>
                <select className="input mt-1" value={size} onChange={(e) => setSize(e.target.value)}>
                  {product.packages.map((k) => <option key={k.value} value={k.value}>{k.value} {product.currency} · {usd(k.price)}</option>)}
                </select></label>
            ) : product.range ? (
              <label className="block"><span className="label">Amount ({product.range.min} to {product.range.max} {product.currency})</span>
                <input className="input mt-1" type="number" min={product.range.min} max={product.range.max} value={size} onChange={(e) => setSize(e.target.value)} /></label>
            ) : <p className="text-sm neg">This product has no sizes to choose from right now.</p>}
            {product.recipientType !== "none" && (
              <label className="block"><span className="label">{product.recipientType === "phone_number" ? "Phone number to top up (with country code)" : `The ${product.recipientType.replace("_", " ")} to top up`}</span>
                <input className="input mt-1" value={recipient} onChange={(e) => setRecipient(e.target.value)} /></label>
            )}
            <label className="block sm:col-span-2"><span className="label">Email for the receipt and the code</span>
              <input className="input mt-1" type="email" placeholder="finance@yourcompany.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="text-xs" style={{ color: "var(--tx-2)" }}>The code is emailed here by Bitrefill. This app never keeps it.</span></label>
          </div>
          <p className="mt-3 text-sm" style={{ color: "var(--tx-1)" }}>Ordering does not spend anything yet. It makes a payment that goes through your rules and your treasury&apos;s approval, like any invoice. <strong>Bitrefill holds the price for about 15 minutes</strong>, so the people who approve need to do it in that time.</p>
          <button className="btn btn-primary mt-3" disabled={loading || !size || !email.includes("@")} aria-busy={loading} onClick={async () => {
            const r = await run<{ payment: { id: string } }>("/api/bills", { productId: product.id, packageValue: size, email, recipient: recipient || undefined }, "POST", "Order made: now it needs approval");
            if (r) router.push(`/payments/${r.payment.id}`);
          }}>Order it</button>
          <ErrorLine msg={error} />
        </div>
      )}
    </div>
  );
}

/** Ask Bitrefill where an order stands. */
export function CheckBill({ paymentId }: { paymentId: string }) {
  const { run, error, loading } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button className="btn btn-ghost btn-sm" disabled={loading} aria-busy={loading} onClick={() => run("/api/bills", { refresh: paymentId }, "POST", "Checked with Bitrefill")}>Check delivery</button>
      <ErrorLine msg={error} />
    </span>
  );
}

