"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorLine } from "@/components/Actions";

export function LoginForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <form
      className="mt-4 grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
          const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
          if (res.ok) {
            router.push("/");
            router.refresh();
            return;
          }
          setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not sign in.");
        } catch {
          setError("Could not reach the server.");
        } finally {
          setLoading(false);
        }
      }}
    >
      <label className="block"><span className="label">Signer token</span>
        <input className="input mt-1" type="password" autoComplete="current-password" required value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={loading || !token}>{loading ? "Signing in…" : "Sign in"}</button>
      <ErrorLine msg={error} />
    </form>
  );
}
