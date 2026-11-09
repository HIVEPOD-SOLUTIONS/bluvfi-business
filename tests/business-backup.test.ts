import { BUCKET_PORT, DIR } from "./setup-business-backup";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { GET, POST } from "../app/api/business-backup/route";
import { signS3 } from "../lib/backup";
import { createBusiness, getBusiness, setTreasury } from "../lib/business";
import { assertPublicEndpoint, backupSettingsView, businessBackupsDue, businessBackupWarning, makeBusinessBackup, openBusinessBackup, restoreBusinessBackup, runBusinessBackup, setBackupSettings } from "../lib/business-backup";
import { COOKIE, issueSession, privySubject } from "../lib/session";
import { persist, resetAllState, state } from "../lib/store";
import { addMember } from "../lib/team";
import { runAs } from "../lib/tenant";
import type { Vendor } from "../lib/types";

// ---------- The business's own bucket: stores objects and refuses any request not signed with the business's key ----------
const objects = new Map<string, Buffer>();
const KEY = { id: "BIZKEYID123", secret: "biz-secret-access-key" };
const bucket = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const d = String(req.headers["x-amz-date"] ?? "");
    const at = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
    const extra: Record<string, string> = req.headers["content-type"] ? { "content-type": String(req.headers["content-type"]) } : {};
    if (req.headers.authorization !== signS3(req.method!, url, extra, String(req.headers["x-amz-content-sha256"]), { region: "auto", accessKeyId: KEY.id, secretAccessKey: KEY.secret }, at).authorization) {
      res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); return; }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204).end(); return; }
    if (url.searchParams.get("list-type") === "2") {
      const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? ""));
      res.writeHead(200).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Key>${k}</Key>`).join("")}</ListBucketResult>`);
      return;
    }
    const o = objects.get(key);
    if (!o) { res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    res.writeHead(200).end(o);
  });
}).listen(BUCKET_PORT, "127.0.0.1");
after(() => bucket.close());

const ENDPOINT = `http://127.0.0.1:${BUCKET_PORT}`;
const PASS = "correct horse battery staple";
const acme = createBusiness("Acme Backups Ltd", "owner@acme.test");
const other = createBusiness("Other Co", "owner@other.test");
const AGENT_KEY = "ed25519:4wGGLPhkfLEnRSGv8NnNkAsS1MqdAn5bLNY3V1DEe3mqd6YdS4uEEc5pDHLPq3rJKWp2HM3hQ2ehuYBJrNNWp6Ta";
setTreasury(acme.id, { custody: "sputnik", dao: "acme.sputnik-dao.near", agent: "acme-agent.near", agentKey: AGENT_KEY });

const cookie = async (biz: string, email: string) => `${COOKIE}=${encodeURIComponent((await issueSession(privySubject(biz, email)))!)}`;
const call = async (fn: typeof POST, c: string | null, b?: unknown) =>
  fn(new Request("https://x.example/api/business-backup", { method: b ? "POST" : "GET", headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: b ? JSON.stringify(b) : undefined }));

test("an owner turns backups on: settings are checked, secrets are never shown again, and the first backup lands in the business's own folder of its bucket", async () => {
  runAs(acme.id, () => { state().vendors.push({ name: "Acme Secret Supplier" } as Vendor); persist(); });
  runAs(other.id, () => { state().vendors.push({ name: "Other Co Supplier" } as Vendor); persist(); });
  const owner = await cookie(acme.id, "owner@acme.test");
  assert.equal((await call(GET, null)).status, 401);
  assert.match(((await (await call(POST, owner, { action: "save", endpoint: ENDPOINT, bucket: "acme", accessKeyId: KEY.id, secretAccessKey: KEY.secret, passphrase: "short" })).json()) as { error: string }).error, /at least 12 characters/);
  const res = await call(POST, owner, { action: "save", endpoint: ENDPOINT, bucket: "acme-backups", region: "auto", accessKeyId: KEY.id, secretAccessKey: KEY.secret, passphrase: PASS });
  const out = (await res.json()) as { first: { ok: boolean; name: string }; settings: Record<string, unknown> };
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.first.ok, true, "a first backup straight away");
  assert.ok(objects.has(`bluvfi/${acme.id}/${out.first.name}`), "in this business's own folder of its bucket");
  const shown = JSON.stringify(await (await call(GET, owner)).json());
  assert.ok(!shown.includes(KEY.secret) && !shown.includes(PASS), "the secret key and passphrase are never sent back");
  assert.ok(!JSON.stringify(getBusiness(acme.id)!.backup).includes(PASS), "and are stored encrypted");
});

test("the backup holds this business's records and nobody else's, without stored keys, and opens with the passphrase alone", () => {
  const raw = [...objects.values()][0];
  const text = raw.toString();
  assert.ok(!text.includes("Acme Secret Supplier"), "encrypted");
  assert.throws(() => openBusinessBackup(raw, "the wrong passphrase!"), /does not open with that passphrase/);
  const b = openBusinessBackup(raw, PASS);
  assert.equal(b.business.name, "Acme Backups Ltd");
  assert.deepEqual(b.records.live!.vendors.map((v) => v.name), ["Acme Secret Supplier"]);
  const all = JSON.stringify(b);
  assert.ok(!all.includes("Other Co Supplier"), "no other business's records");
  assert.ok(!all.includes(AGENT_KEY) && !all.includes("acme.sputnik-dao.near"), "no stored keys or treasury settings");
});

test("an approver cannot manage backups, and the operator's own business uses the platform backup instead", async () => {
  runAs(acme.id, () => addMember("owner@acme.test", "approver@acme.test", "approver"));
  assert.equal((await call(GET, await cookie(acme.id, "approver@acme.test"))).status, 403);
  await assert.rejects(setBackupSettings("default", { endpoint: ENDPOINT, bucket: "x-bucket", accessKeyId: KEY.id, secretAccessKey: KEY.secret, passphrase: PASS }), /platform backup/);
});

test("restore from Settings puts the records back and keeps the ones it replaced", async () => {
  const name = backupSettingsView(acme.id).status.lastName!;
  runAs(acme.id, () => { state().vendors.splice(0); persist(); });
  const owner = await cookie(acme.id, "owner@acme.test");
  const res = await call(POST, owner, { action: "restore", name });
  const out = (await res.json()) as { result: { restored: string[]; kept: string[] } };
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(out.result.restored, ["live"]);
  assert.ok(out.result.kept.every((k) => existsSync(k)), "the replaced records are kept");
  resetAllState();
  runAs(acme.id, () => assert.deepEqual(state().vendors.map((v) => v.name), ["Acme Secret Supplier"]));
  runAs(other.id, () => assert.deepEqual(state().vendors.map((v) => v.name), ["Other Co Supplier"], "the other business is untouched"));
  await assert.rejects(restoreBusinessBackup(acme.id, "../../other.enc"), /not one of this business's backups/);
});

test("a bucket on a private or local address is refused, so a business cannot point the server at its own network", async () => {
  process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS = "0";
  try {
    for (const bad of ["http://s3.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.5", "https://localhost:9000", "https://[::1]", "https://metadata.google.internal"]) {
      await assert.rejects(assertPublicEndpoint(bad), /https:\/\/|public address|could not be found/, bad);
    }
  } finally {
    process.env.BLUVFI_ALLOW_PRIVATE_BACKUP_ENDPOINTS = "1";
  }
});

test("the schedule backs up each business once a day, keeps trying after a failure without hammering, and warns the owner", async () => {
  const last = Date.parse(backupSettingsView(acme.id).status.lastOkAt!);
  assert.deepEqual(await businessBackupsDue(new Date(last + 3_600_000)), {}, "not due an hour later");
  const due = await businessBackupsDue(new Date(last + 25 * 3_600_000));
  assert.match(due[acme.id], /^bluvfi-backup-/);
  // A day later the bucket starts refusing the key.
  const T = last + 25 * 3_600_000 + 25 * 3_600_000;
  getBusiness(acme.id)!.backup!.accessKeyId = "REVOKEDKEY99";
  assert.match((await businessBackupsDue(new Date(T)))[acme.id], /^failed: S3 PUT answered 403 \(SignatureDoesNotMatch\)/);
  assert.match(businessBackupWarning(acme.id, T), /last backup of this business failed/);
  assert.deepEqual(await businessBackupsDue(new Date(T + 15 * 60_000)), {}, "no retry within the hour");
  assert.match((await businessBackupsDue(new Date(T + 2 * 3_600_000)))[acme.id], /^failed: /, "but again later");
  getBusiness(acme.id)!.backup!.accessKeyId = KEY.id;
  await runBusinessBackup(acme.id, new Date(T + 3 * 3_600_000));
  assert.equal(businessBackupWarning(acme.id, T + 3 * 3_600_000), "", "fixed: the warning goes away");
  assert.ok(readdirSync(join(DIR, "businesses")).length > 0);
  assert.ok(makeBusinessBackup(acme.id).body.length > 0);
});
