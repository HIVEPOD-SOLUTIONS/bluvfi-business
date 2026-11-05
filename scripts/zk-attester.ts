/**
 * `npm run zk:attester`: run an independent attester (lib/zk-attester.ts). It checks facts itself (balances on the NEAR chain, approvals at
 * Persona) and signs only what is true, so a credential or balance proof can require several issuers to agree.
 *
 *   ATTESTER_KEY     64 hex characters: this attester's secret (its key is derived from it; `npm run zk:attester -- --new` makes one)
 *   ATTESTER_TOKEN   the bearer token the app must send (16+ characters)
 *   ATTESTER_PORT    default 47870
 *   PERSONA_API_KEY  for credential attestations (its own key, not the app's)
 *
 * Then, in the app's .env.local:  ZK_ATTESTERS="http://host:47870|<token>|<this attester's public key>"  and  ZK_ATTEST_THRESHOLD=2
 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* only what the shell has */
  }
  if (process.argv.includes("--new")) {
    console.log(`ATTESTER_KEY=${randomBytes(32).toString("hex")}\nATTESTER_TOKEN=${randomBytes(24).toString("hex")}`);
    process.exit(0);
  }
  const secret = process.env.ATTESTER_KEY ?? "";
  const token = process.env.ATTESTER_TOKEN ?? "";
  if (token.length < 16) throw new Error("Set ATTESTER_TOKEN (16 or more characters)");
  const { attest, attesterKey } = await import("../lib/zk-attester");
  const publicKey = (await attesterKey(secret)).toPublicKey().toBase58();
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/info") return send(200, { publicKey });
    if (req.method !== "POST" || req.url !== "/attest") return send(404, { error: "Not found" });
    if (!same(req.headers.authorization ?? "", `Bearer ${token}`)) return send(401, { error: "Not authorised" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
    req.on("end", async () => {
      try {
        send(200, await attest(JSON.parse(raw || "{}"), secret));
      } catch (e) {
        send(422, { error: (e as Error).message });
      }
    });
  });
  const port = Number(process.env.ATTESTER_PORT ?? 47870);
  server.listen(port, () => console.log(`Attester listening on :${port}\nPublic key: ${publicKey}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
