/**
 * `npm run confidential:check -- <dao> [--agent <account>]`: will this DAO work as a confidential treasury for Bluvfi Business?
 * Works on any NEAR Business or Trezu confidential treasury, with no access to anyone's app: such a treasury is a public Sputnik DAO,
 * so its policy, its signing requests and their signatures are all on the chain. Read-only: it files nothing and signs nothing.
 *
 *   <dao>              the treasury's DAO account, for example acme.sputnik-dao.near (it is in the treasury's address in Trezu)
 *   --agent <account>  also check that this agent account can file proposals into it and cannot vote
 *
 * Exits non-zero if the DAO is incompatible.
 */
export {}; // a module, so its names do not clash with the other scripts

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--agent");
  const agent = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const dao = args[0];
  if (!dao) throw new Error("Usage: npm run confidential:check -- <dao> [--agent <account>]");
  const { checkConfidentialCompat } = await import("../lib/confidential-check");
  const r = await checkConfidentialCompat(dao, agent);
  console.log(`\nConfidential treasury check for ${dao}${agent ? ` with agent ${agent}` : ""}\n`);
  for (const f of r.findings) console.log(`  ${f.ok === true ? "✓" : f.ok === false ? "✕" : "·"} ${f.text}`);
  if (r.signRequests.length) {
    console.log("\nIts requests to the MPC signer:");
    for (const s of r.signRequests) console.log(`  #${s.id} ${s.status.padEnd(10)} ${s.kind === "treasury" ? `for the DAO's own account${s.sameAsOurs ? ", same as ours" : ", DIFFERENT from ours"}${s.signatureVerified ? ", signature verified" : ""}` : "for another path"}  "${s.description.slice(0, 60)}"`);
  }
  const verdict = { compatible: "COMPATIBLE: its history matches what this app does.", compatible_untested: "COMPATIBLE IN PRINCIPLE: nothing wrong, but it has no signing history to compare.", incompatible: "NOT COMPATIBLE yet: fix the ✕ lines above." }[r.verdict];
  console.log(`\n${verdict}\nWhat this cannot see: the shielded balance and the 1Click login, which only the council can open.\n`);
  if (r.verdict === "incompatible") process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
