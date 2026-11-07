"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Demo or live, for this business. Demo runs on fixtures and keeps its own records; live uses the real chain, AI and treasury. Only an owner can
 * switch; anyone else sees which one it is. Going live asks first, and the server refuses until the treasury is set up.
 */
export function ModeSwitch({ mode, owner, wide = false }: { mode: "demo" | "live"; owner: boolean; wide?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go(next: "demo" | "live") {
    if (next === mode || busy) return;
    if (next === "live" && !window.confirm("Go live? This business will use the real chain, the real AI review and its real treasury, and payments it approves move real money. Your demo records stay separate and come back if you switch back.")) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: next }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `Something went wrong (${res.status}).`);
      else router.refresh();
    } catch { setError("Could not reach the server."); }
    finally { setBusy(false); }
  }

  const seg = (m: "demo" | "live", label: string) => (
    <button
      key={m} type="button" role="radio" aria-checked={mode === m} disabled={!owner || busy} onClick={() => void go(m)}
      className="px-3 py-1 text-xs font-semibold transition-colors"
      style={{ background: mode === m ? (m === "live" ? "rgba(52,199,123,.22)" : "rgba(201,168,76,.22)") : "transparent", color: mode === m ? "#fff" : "var(--tx-2)", cursor: owner ? "pointer" : "default" }}
    >{label}</button>
  );
  return (
    <div className={wide ? "" : "mb-5"}>
      <div role="radiogroup" aria-label="Demo or live" title={owner ? "Switch between demo and live" : "Only an owner can switch"} className="inline-flex overflow-hidden rounded-full border" style={{ borderColor: "var(--bd)" }}>
        {seg("demo", "Demo")}{seg("live", "Live")}
      </div>
      {error && <p role="alert" className="shake mt-2 text-xs neg">{error}</p>}
    </div>
  );
}
