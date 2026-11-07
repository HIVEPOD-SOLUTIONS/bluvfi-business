"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "@/components/Toast";

/** POST JSON, then refresh server data and say, gently, that it worked. Surfaces the server's plain-language error. `done` is the note shown on success. */
export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T = unknown>(url: string, payload?: unknown, method = "POST", done = "Done"): Promise<T | null> {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Something went wrong (${res.status}).`);
        return null;
      }
      toast(done);
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
  return msg ? <p key={msg} role="alert" className="shake mt-2 text-sm neg">{msg}</p> : null;
}

export function ActionButton({
  url, payload, children, variant = "secondary", small, confirm, done,
}: {
  url: string; payload?: unknown; children: React.ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; small?: boolean; confirm?: string; done?: string;
}) {
  const { run, error, loading } = useAction();
  return (
    <span className="inline-flex flex-col">
      <button
        className={`btn btn-${variant} ${small ? "btn-sm" : ""}`}
        disabled={loading} aria-busy={loading}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          run(url, payload, "POST", done);
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
        disabled={loading} aria-busy={loading}
        onClick={() => run("/api/kill", { on: !on }, "POST", on ? "Payments are running again" : "All payments are stopped")}
        className={`btn ${on ? "btn-primary" : "btn-danger"}`}
      >
        {on ? "Resume payments" : "Kill switch: stop all payments"}
      </button>
      <ErrorLine msg={error} />
    </div>
  );
}
