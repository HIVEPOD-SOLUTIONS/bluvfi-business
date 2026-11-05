/**
 * `npm run zk:claim:verify -- <proof.json> [--issuer <base58>] [--list-root <root>]`: verify a zero-knowledge claim file, on its own, with
 * nothing but the committed verification keys (zk/claims-verification-keys.json). Anyone can run this on a proof they were given.
 */
async function main() {
  const { readFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Usage: npm run zk:claim:verify -- <proof.json> [--issuer <public key>] [--list-root <root>]");
  const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const { verifyClaim } = await import("../lib/zk-claims");
  const art = JSON.parse(readFileSync(file, "utf8"));
  const r = await verifyClaim(art.artifact ?? art, { issuer: flag("--issuer"), listRoots: flag("--list-root") ? [flag("--list-root")!] : undefined });
  console.log(`${r.valid ? "VALID" : "INVALID"}: ${r.kind}`);
  console.log(JSON.stringify(r.statement, null, 2));
  for (const p of r.problems) console.log(`  problem: ${p}`);
  process.exit(r.valid ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
