import { OUT, S3_PORT } from "./setup-backup";
import { DIR } from "./setup-vault";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backupIfDue, backupName, backupStatus, backupWarning, folderDestination, listBackups, makeBackup, openBackup, prune, restoreBackup, runBackup, signS3 } from "../lib/backup";
import { persist, resetAllState, state } from "../lib/store";
import { runAs } from "../lib/tenant";

// ---------- A small S3: stores objects, lists them, and refuses any request whose signature does not check out ----------
const objects = new Map<string, Buffer>();
let refused = 0;
const s3 = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const sent = String(req.headers.authorization ?? "");
    const date = String(req.headers["x-amz-date"] ?? "");
    const at = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const extra: Record<string, string> = req.headers["content-type"] ? { "content-type": String(req.headers["content-type"]) } : {};
    const expect = signS3(req.method!, url, extra, String(req.headers["x-amz-content-sha256"]), { region: "auto", accessKeyId: "TESTKEYID", secretAccessKey: "test-secret-key" }, at).authorization;
    if (sent !== expect) {
      refused++;
      res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    if (req.method === "PUT") { objects.set(key, body); res.writeHead(200).end(); return; }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204).end(); return; }
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
      return;
    }
    const o = objects.get(key);
    if (!o) { res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    res.writeHead(200).end(o);
  });
}).listen(S3_PORT, "127.0.0.1");
after(() => s3.close());

test("the S3 signature matches AWS's own published example (Signature Version 4, GET Object with a range)", () => {
  const h = signS3("GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"), { range: "bytes=0-9" }, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, new Date("2013-05-24T00:00:00Z"));
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

const SECRET_VENDOR = "Backup Secret Vendor GmbH";

test("a backup holds every record file, encrypted, and goes to the folder and the bucket; each copy is read back and checked", async () => {
  runAs("default", () => {
    state().vendors.push({ name: SECRET_VENDOR } as never);
    persist();
  });
  mkdirSync(join(DIR, "zk", "proofs"), { recursive: true });
  mkdirSync(join(DIR, "zk", "cache"), { recursive: true });
  writeFileSync(join(DIR, "zk", "cache", "wrap-pk"), "proving key: rebuilt by o1js, not backed up");
  writeFileSync(join(DIR, "zk", "proofs", "pay-1.json"), '{"proof":"abc"}');
  writeFileSync(join(DIR, "sanctions.json"), "{}"); // the public OFAC cache: downloaded again, not backed up
  mkdirSync(join(DIR, "state.json.lock"), { recursive: true }); // a lock someone holds: never backed up
  writeFileSync(join(DIR, "state.json.123.tmp"), "half written");

  const s = await runBackup(new Date("2026-11-09T10:00:00.000Z"));
  assert.deepEqual(s.results!.map((r) => r.ok), [true, true], JSON.stringify(s.results));
  assert.equal(s.lastName, "bluvfi-backup-20261109T100000000Z.enc");
  assert.ok(existsSync(join(OUT, s.lastName!)));
  assert.ok(objects.has(`bluvfi/${s.lastName}`), "in the bucket under the prefix");
  assert.equal(refused, 0, "every request to the bucket was signed correctly");

  const raw = readFileSync(join(OUT, s.lastName!), "utf8");
  assert.ok(!raw.includes(SECRET_VENDOR) && !raw.includes("state.json") && !raw.includes("proofs"), "nothing inside can be read, not even file names");
  const paths = openBackup(Buffer.from(raw)).files.map((f) => f.path);
  assert.ok(paths.includes("state.json") && paths.includes("zk/proofs/pay-1.json"), "paths are kept relative to the data folder");
  assert.ok(!paths.some((p) => p.endsWith("sanctions.json") || p.includes(".lock") || p.endsWith(".tmp") || p.startsWith("zk/cache")), "no cache, lock or temp file");
  assert.equal(backupWarning(Date.parse("2026-11-09T11:00:00Z")), "");
});

test("a damaged backup, or one opened with another master key, is refused with the reason", () => {
  const { body } = makeBackup(new Date("2026-11-09T10:30:00Z"));
  const [format, id, sealed] = body.toString().trim().split("\n");
  assert.throws(() => openBackup(Buffer.from(`${format}\n000000000000\n${sealed}\n`)), /different BLUVFI_MASTER_KEY/);
  const bytes = Buffer.from(sealed, "base64");
  bytes[bytes.length - 1] ^= 1; // one bit of the ciphertext
  const flipped = bytes.toString("base64");
  assert.throws(() => openBackup(Buffer.from(`${format}\n${id}\n${flipped}\n`)), /damaged/);
  assert.throws(() => openBackup(Buffer.from("not a backup")), /not a Bluvfi Business backup/);
});

test("restore: into a separate folder byte for byte; in place only with --force, and the current folder is moved aside, never deleted", async () => {
  const body = readFileSync(join(OUT, "bluvfi-backup-20261109T100000000Z.enc"));
  const look = mkdtempSync(join(tmpdir(), "bluvfi-restore-"));
  const r = restoreBackup(body, { to: look });
  const statePath = join(look, "state.json");
  assert.deepEqual(readFileSync(statePath), readFileSync(join(DIR, "state.json")), "the records file comes back byte for byte");
  assert.equal(r.files, openBackup(body).files.length);

  // Disaster: the records are changed after the backup. Restoring in place needs --force, and keeps what was there.
  runAs("default", () => {
    state().vendors.splice(0);
    persist();
  });
  assert.throws(() => restoreBackup(body), /already holds records.*--force/);
  const done = restoreBackup(body, { force: true, now: new Date("2026-11-09T12:00:00Z") });
  assert.ok(done.movedAside && existsSync(done.movedAside), "the folder that was there is kept");
  resetAllState();
  runAs("default", () => assert.ok(state().vendors.some((v) => v.name === SECRET_VENDOR), "the app reads the restored records"));
});

test("old backups are deleted after the retention period, but the newest three are always kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bluvfi-prune-"));
  const d = folderDestination(dir);
  const now = Date.parse("2026-11-09T00:00:00Z");
  const days = [0, 1, 2, 40, 50, 60];
  for (const n of days) await d.put(backupName(new Date(now - n * 86_400_000)), Buffer.from("x"));
  assert.equal(await prune(d, now), 3);
  assert.equal(readdirSync(dir).length, 3);
  // Even when everything is old (backups stopped for months), the newest three stay.
  const all = mkdtempSync(join(tmpdir(), "bluvfi-prune2-"));
  const d2 = folderDestination(all);
  for (const n of [100, 101, 102, 103]) await d2.put(backupName(new Date(now - n * 86_400_000)), Buffer.from("x"));
  await prune(d2, now);
  assert.equal(readdirSync(all).length, 3);
});

test("the schedule runs a backup only when one is due, and the warning says when backups fall behind or fail", async () => {
  // After a restore the status starts empty (the old folder, status included, was moved aside), so a backup is due at once.
  assert.equal(backupStatus().lastOkAt, undefined);
  assert.match(backupWarning(), /No backup has been made yet/);
  const last = Date.parse((await runBackup(new Date("2026-11-10T00:00:00.000Z"))).lastOkAt!);
  assert.equal((await backupIfDue(new Date(last + 3_600_000))).ran, false, "an hour later: not due");
  const r = await backupIfDue(new Date(last + 25 * 3_600_000));
  assert.equal(r.ran, true);
  assert.ok(r.status?.results?.every((x) => x.ok));
  assert.match(backupWarning(last + 25 * 3_600_000 + 49 * 3_600_000), /more than 48 hours ago/);
  assert.equal((await listBackups()).length >= 4, true, "both backups at both destinations");

  // The bucket starts refusing: the backup still lands in the folder, and the failure is reported.
  process.env.BLUVFI_BACKUP_S3_SECRET_ACCESS_KEY = "wrong";
  try {
    const s = await runBackup(new Date(last + 30 * 3_600_000));
    assert.deepEqual(s.results!.map((x) => x.ok), [true, false]);
    assert.match(s.results![1].error!, /403 \(SignatureDoesNotMatch\)/);
    assert.match(backupWarning(last + 30 * 3_600_000), /last backup failed for S3 bucket bluvfi-test/);
  } finally {
    process.env.BLUVFI_BACKUP_S3_SECRET_ACCESS_KEY = "test-secret-key";
  }
});
