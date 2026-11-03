"use client";
import { PrivyProvider, useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorLine } from "@/components/Actions";

type Choice = { id: string; name: string; role: string };

/**
 * Sign in with an email or Google login. Privy proves who you are; the server then finds the businesses you belong to:
 * one signs you in, several let you choose, and none lets you create your own business.
 */
export function PrivyLogin({ appId, signupOpen }: { appId: string; signupOpen: boolean }) {
  return (
    <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google", "github"], appearance: { theme: "dark", accentColor: "#0a0ae8" } }}>
      <Flow signupOpen={signupOpen} />
    </PrivyProvider>
  );
}

function Flow({ signupOpen }: { signupOpen: boolean }) {
  const router = useRouter();
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { logout } = useLogout();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [name, setName] = useState("");

  const done = () => {
    router.push("/");
    router.refresh();
  };

  async function call(url: string, extra: object) {
    setBusy(true);
    setError(null);
    try {
      const accessToken = await getAccessToken();
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken, ...extra }) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; choose?: Choice[]; signup?: boolean };
      if (res.ok && json.choose) return setChoices(json.choose);
      if (res.ok) return done();
      setError(json.error ?? "Could not sign in.");
      if (json.signup && signupOpen) setCanCreate(true);
      else if (!json.signup) await logout(); // so the next attempt can use a different account
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }
  const exchange = (businessId?: string) => call("/api/login/privy", { businessId });
  const { login } = useLogin({ onComplete: () => void exchange() });

  if (choices) {
    return (
      <div className="grid gap-2">
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>You are on more than one business. Which one?</p>
        {choices.map((c) => (
          <button key={c.id} className="btn btn-secondary justify-between" disabled={busy} onClick={() => void exchange(c.id)}>
            <span>{c.name}</span><span className="label">{c.role}</span>
          </button>
        ))}
        <ErrorLine msg={error} />
      </div>
    );
  }

  if (canCreate) {
    return (
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void call("/api/signup", { businessName: name }); }}>
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>No business uses this email yet. Create yours: you become its owner, then add your team and set up the treasury.</p>
        <label className="block"><span className="label">Business name</span>
          <input className="input mt-1" required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>{busy ? "Creating…" : "Create business"}</button>
        <ErrorLine msg={error} />
      </form>
    );
  }

  return (
    <div className="grid gap-2">
      <button className="btn btn-primary" disabled={!ready || busy} onClick={() => (authenticated ? void exchange() : login())}>
        {!ready ? "Loading…" : busy ? "Signing in…" : signupOpen ? "Continue with email or Google" : "Sign in with email or Google"}
      </button>
      <ErrorLine msg={error} />
    </div>
  );
}
