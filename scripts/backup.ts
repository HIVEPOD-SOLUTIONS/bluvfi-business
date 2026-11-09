// Backups from the command line (lib/backup.ts). Reads .env.local like the app.
//   npm run backup                          make one now and send it to every destination
//   npm run backup -- list                  every backup at every destination, newest first
//   npm run backup -- verify <name|file>    open one and check every file's checksum, writing nothing
//   npm run backup -- restore <name|file> --to <folder>   put its files in a separate folder, to look inside
//   npm run backup -- restore <name|file> --force         put it back in place (stop the app first; the current
//                                                         data folder is moved aside, never deleted)
//   BLUVFI_BACKUP_PASSPHRASE=... npm run backup -- open <file> [--out records.json]
//                                           open one business's own backup (made from its Settings page) with its passphrase.
//                                           Needs nothing from the platform: no master key, no records.
export {}; // a module, so its names do not clash with the other scripts
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: the environment alone */
}

async function main() {
  const b = await import("../lib/backup");
  const [cmd = "now", target, ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f) || target === f;
  const value = (f: string) => {
    const all = [target, ...rest];
    const i = all.indexOf(f);
    return i >= 0 ? all[i + 1] : undefined;
  };
  if (cmd === "now") {
    const s = await b.runBackup();
    for (const r of s.results ?? []) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.destination}${r.ok ? `${r.deleted ? `, ${r.deleted} old backup(s) deleted` : ""}` : `: ${r.error}`}`);
    console.log(`${s.lastName}: ${s.lastFiles} files, ${(s.lastBytes ?? 0).toLocaleString()} bytes, encrypted.`);
    if ((s.results ?? []).some((r) => !r.ok)) process.exit(1);
  } else if (cmd === "open") {
    if (!target || target.startsWith("--")) throw new Error("Which file? BLUVFI_BACKUP_PASSPHRASE=... npm run backup -- open <file> [--out records.json]");
    const passphrase = process.env.BLUVFI_BACKUP_PASSPHRASE;
    if (!passphrase) throw new Error("Set BLUVFI_BACKUP_PASSPHRASE to the passphrase chosen in Settings (an environment variable, so it stays out of your shell history)");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { openBusinessBackup } = await import("../lib/business-backup");
    const bundle = openBusinessBackup(readFileSync(target), passphrase);
    const out = value("--out");
    if (out) writeFileSync(out, JSON.stringify(bundle, null, 2));
    const count = (s: typeof bundle.records.live) => (s ? `${s.payments.length} payments, ${s.vendors.length} vendors` : "none");
    console.log(`${bundle.business.name} (${bundle.business.id}), backed up ${bundle.createdAt}. Live: ${count(bundle.records.live)}. Demo: ${count(bundle.records.demo)}.${out ? ` Written to ${out}.` : " Add --out records.json to write it all out."}`);
  } else if (cmd === "list") {
    const all = await b.listBackups();
    if (!all.length) console.log("No backups yet.");
    for (const x of all) console.log(`${x.at}  ${x.name}  (${x.destination})`);
  } else if (cmd === "verify") {
    if (!target) throw new Error("Which backup? npm run backup -- verify <name or file>");
    const bundle = b.openBackup(await b.fetchBackup(target));
    console.log(`Good: made ${bundle.createdAt}, ${bundle.files.length} files, every checksum matches.`);
  } else if (cmd === "restore") {
    if (!target || target.startsWith("--")) throw new Error("Which backup? npm run backup -- restore <name or file> [--to <folder> | --force]");
    const r = b.restoreBackup(await b.fetchBackup(target), { to: value("--to"), force: flag("--force") });
    console.log(`Restored ${r.files} files from the backup made ${r.createdAt} into ${r.into}.`);
    if (r.movedAside) console.log(`The data folder that was there is kept at ${r.movedAside}.`);
  } else {
    throw new Error(`Unknown command ${cmd}. Use: now, list, verify <name>, restore <name> [--to <folder> | --force], open <file>`);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
