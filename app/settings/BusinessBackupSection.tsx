"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { Badge } from "@/components/ui";

type Settings = { on: boolean; endpoint: string; bucket: string; region: string; prefix: string; accessKeyId: string; status: { lastAttemptAt?: string; lastOkAt?: string; lastName?: string; lastBytes?: number; error?: string } };
type Data = { settings: Settings; backups: { name: string; at: string }[]; listError?: string };

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");
const kb = (n?: number) => (n === undefined ? "" : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function fetchSettings(): Promise<{ ok: boolean; json: Data & { error?: string } }> {
  try {
    const res = await fetch("/api/business-backup", { cache: "no-store" });
    return { ok: res.ok, json: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, json: { error: "Could not reach the server" } as Data & { error?: string } };
  }
}

const Field = ({ label, value, set, type = "text", ph, hint }: { label: string; value: string; set: (v: string) => void; type?: string; ph?: string; hint?: string }) => (
  <label className="block">
    <span className="label">{label}</span>
    <input className="input mt-1" type={type} autoComplete={type === "password" ? "new-password" : "off"} placeholder={ph} value={value} onChange={(e) => set(e.target.value)} />
    {hint && <span className="mt-1 block text-xs" style={{ color: "var(--tx-2)" }}>{hint}</span>}
  </label>
);

/**
 * A signed-up business backs up its own records to its own bucket, encrypted with a passphrase it chooses (lib/business-backup.ts).
 * The secret key and the passphrase are sent once and never shown again.
 */
export function BusinessBackupSection({ owner }: { owner: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [f, setF] = useState({ endpoint: "", bucket: "", region: "", accessKeyId: "", secretAccessKey: "", passphrase: "", again: "" });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const apply = useCallback((r: { ok: boolean; json: Data & { error?: string } }) => {
    if (!r.ok) return setError(r.json.error ?? "Could not load the backup settings");
    setData(r.json);
    const s = r.json.settings;
    setF((x) => ({ ...x, endpoint: s.endpoint, bucket: s.bucket, region: s.region, accessKeyId: s.accessKeyId }));
  }, []);
  const load = useCallback(async () => apply(await fetchSettings()), [apply]);
  useEffect(() => {
    if (!owner) return;
    let gone = false;
    void fetchSettings().then((r) => { if (!gone) apply(r); });
    return () => { gone = true; };
  }, [owner, apply]);

  async function post(action: string, extra: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/business-backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "That did not work"); await load(); return null; }
      return json;
    } catch {
      setError("Could not reach the server");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const on = !!data?.settings.on;
  const st = data?.settings.status ?? {};
  const failing = !!st.error && (!st.lastOkAt || (st.lastAttemptAt ?? "") > st.lastOkAt);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (f.passphrase && f.passphrase !== f.again) return setError("The two passphrases are not the same");
    const { again: _again, ...fields } = f;
    void _again;
    const sent = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()));
    const out = await post("save", sent);
    if (!out) return;
    setF((x) => ({ ...x, secretAccessKey: "", passphrase: "", again: "" }));
    const first = out.first as { ok: boolean; name?: string; error?: string };
    if (first.ok) toast("Saved, and the first backup is in your bucket");
    else setError(`Saved, but the first backup failed: ${first.error}`);
    await load();
  }

  return (
    <section className="card mb-4" style={{ borderColor: !on ? "var(--bd)" : failing ? "rgba(224,82,82,.4)" : "var(--bd-sage)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2>Backups of this business</h2>
        <Badge tone={!on ? "default" : failing ? "bad" : "ok"}>{!on ? "Off" : failing ? "Failing" : "On"}</Badge>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>
        Every day, this business&apos;s records (payments, vendors, policies, cards, both live and demo) and its profile go to <strong>your own</strong> S3-compatible bucket: Amazon S3, Cloudflare R2, Backblaze B2 or any other. Each backup is encrypted with a passphrase you choose, so the bucket&apos;s owner cannot read it, and you can open it without this platform. No other business&apos;s data is in it, and no stored keys.
      </p>
      {!owner && <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>Only an owner can set up or restore backups.</p>}
      {owner && !data && !error && <p className="mt-2 text-sm" style={{ color: "var(--tx-2)" }}>Loading…</p>}
      {error && <p role="alert" className="mt-2 text-sm neg">{error}</p>}
      {owner && data && (
        <>
          {on && (
            <dl className="mt-3 grid gap-1 text-sm">
              <div><span className="label">Last good backup</span> {when(st.lastOkAt)}{st.lastOkAt && st.lastBytes ? ` · ${kb(st.lastBytes)}` : ""}</div>
              <div><span className="label">Bucket</span> <span className="mono">{data.settings.bucket}</span> at <span className="mono">{new URL(data.settings.endpoint).host}</span>, folder <span className="mono">{data.settings.prefix}…</span></div>
              {failing && <div className="neg">Last try {when(st.lastAttemptAt)} failed: {st.error}</div>}
            </dl>
          )}
          <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={save}>
            <Field label="Endpoint" value={f.endpoint} set={set("endpoint")} ph="https://<account>.r2.cloudflarestorage.com" hint="Amazon S3: https://s3.<region>.amazonaws.com" />
            <Field label="Bucket" value={f.bucket} set={set("bucket")} ph="acme-backups" />
            <Field label="Region" value={f.region} set={set("region")} ph="auto (R2) or us-east-1" />
            <Field label="Access key id" value={f.accessKeyId} set={set("accessKeyId")} hint="A key that can only read, write, list and delete in this bucket" />
            <Field label="Secret access key" type="password" value={f.secretAccessKey} set={set("secretAccessKey")} ph={on ? "Set. Paste a new one to replace it." : ""} />
            <span />
            <Field label="Passphrase" type="password" value={f.passphrase} set={set("passphrase")} ph={on ? "Set. Type a new one to change it." : "At least 12 characters"} hint="Write it down somewhere safe. Without it no backup can be opened, by you or by us. Older backups keep the passphrase they were made with." />
            <Field label="Passphrase again" type="password" value={f.again} set={set("again")} />
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button className="btn btn-primary" disabled={!!busy}>{busy === "save" ? "Saving and backing up…" : on ? "Save" : "Turn on backups"}</button>
              {on && <button type="button" className="btn btn-secondary" disabled={!!busy} aria-busy={busy === "run"} onClick={async () => { if (await post("run")) { toast("Backed up"); await load(); } }}>{busy === "run" ? "Backing up…" : "Back up now"}</button>}
              {on && <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={async () => { if (window.confirm("Stop backing up this business? Backups already in your bucket stay there.") && (await post("disconnect"))) await load(); }}>Turn off</button>}
            </div>
          </form>
          {on && (
            <div className="mt-4">
              <div className="label mb-1">In your bucket</div>
              {data.listError && <p className="text-sm neg">{data.listError}</p>}
              {!data.listError && data.backups.length === 0 && <p className="text-sm" style={{ color: "var(--tx-2)" }}>No backups yet.</p>}
              <ul className="grid gap-1 text-sm">
                {data.backups.slice(0, 10).map((b) => (
                  <li key={b.name} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{when(b.at)} <span className="mono text-xs" style={{ color: "var(--tx-2)" }}>{b.name}</span></span>
                    <button
                      className="btn btn-ghost btn-sm" disabled={!!busy}
                      onClick={async () => {
                        if (!window.confirm(`Restore the records from ${when(b.at)}? Everything recorded since then is replaced. The current records are kept on the server, not deleted.`)) return;
                        const out = await post("restore", { name: b.name });
                        if (out) { toast("Restored"); router.refresh(); await load(); }
                      }}
                    >{busy === "restore" ? "Restoring…" : "Restore"}</button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs" style={{ color: "var(--tx-2)" }}>To open a backup yourself: download it from your bucket, then run <span className="mono">BLUVFI_BACKUP_PASSPHRASE=… npm run backup -- open &lt;file&gt; --out records.json</span> from this app&apos;s open-source code.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
