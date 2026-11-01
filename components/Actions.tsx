"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** POST JSON, then refresh server data. Surfaces the server's plain-language error. */
export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T = unknown>(url: string, payload?: unknown, method = "POST"): Promise<T | null> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Something went wrong (${res.status}).`);
        return null;
      }
      start(() => router.refresh());
      return json as T;
    } catch {
      setError("Could not reach the server.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { run, error, loading: busy || pending };
}

export function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="mt-2 text-sm neg">{msg}</p> : null;
}

export function ActionButton({
  url, payload, children, variant = "secondary", small, confirm,
}: {
  url: string; payload?: unknown; children: React.ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; small?: boolean; confirm?: string;
}) {
  const { run, error, loading } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button
        className={`btn btn-${variant} ${small ? "btn-sm" : ""}`}
        disabled={loading}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          run(url, payload);
        }}
      >
        {loading ? "Working…" : children}
      </button>
      <ErrorLine msg={error} />
    </span>
  );
}

export function KillSwitch({ on }: { on: boolean }) {
  const { run, error, loading } = useAction();
  return (
    <div>
      <button
        role="switch"
        aria-checked={on}
        disabled={loading}
        onClick={() => run("/api/kill", { on: !on })}
        className={`btn ${on ? "btn-primary" : "btn-danger"}`}
      >
        {on ? "Resume payments" : "Kill switch: stop all payments"}
      </button>
      <ErrorLine msg={error} />
    </div>
  );
}
