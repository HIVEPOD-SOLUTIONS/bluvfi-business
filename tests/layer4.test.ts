import "./setup-layer4";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { POST as checkRoute } from "../app/api/check/route";
import { lookupSignals } from "../lib/chain";
import { payX402 } from "../lib/rails";
import { facilitator } from "../lib/x402";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
async function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, body: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}

// A contract whose code hash now is `nowHash`, and was `thenHash` at the block 30 days back on the archive node.
const nearRpc = (nowHash: string, thenHash: string) => (url: string, init?: RequestInit) => {
  const b = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
  if (url.includes("archival")) {
    if (b.method === "block") return json({ result: { header: { height: 1_000_000_000 } } });
    if (thenHash === "unknown-account") return json({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
    if (thenHash === "gone") return json({ error: { cause: { name: "GARBAGE_COLLECTED_BLOCK" } } });
    return json({ result: { code_hash: thenHash } });
  }
  if (url.includes("nearblocks")) return json({ data: { created: { block_timestamp: String(BigInt(Date.now() - 400 * 86_400_000) * BigInt(1_000_000)) } } });
  return json({ result: { code_hash: nowHash, amount: "1" } });
};

test("a contract whose code changed in the last 30 days is flagged; the same code is not; an unreachable archive is unknown, never no", async () => {
  await withFetch(nearRpc("NEWHASH", "OLDHASH"), async () => assert.equal((await lookupSignals("swapped-a.near", "near"))?.codeChangedRecently, true));
  await withFetch(nearRpc("SAMEHASH", "SAMEHASH"), async () => assert.equal((await lookupSignals("steady-b.near", "near"))?.codeChangedRecently, false));
  await withFetch(nearRpc("NEWHASH", "unknown-account"), async () => assert.equal((await lookupSignals("deployed-c.near", "near"))?.codeChangedRecently, true));
  await withFetch(nearRpc("NEWHASH", "gone"), async () => assert.equal((await lookupSignals("unknown-d.near", "near"))?.codeChangedRecently, null));
});

test("an account with no contract is never reported as having changed code", async () => {
  await withFetch(nearRpc("11111111111111111111111111111111", "x"), async (calls) => {
    assert.equal((await lookupSignals("plain-e.near", "near"))?.codeChangedRecently, false);
    assert.ok(!calls.some((c) => c.url.includes("archival")), "no archive lookup for a plain account");
  });
});

test("an agent can pay a POST API: the same method and body go out with the payment", async () => {
  const seen: { method?: string; body: string; paid: boolean }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/payer/pay") return send(200, { paymentHeader: "signed" });
      seen.push({ method: req.method, body: raw, paid: !!req.headers["x-payment"] });
      if (req.headers["x-payment"]) return send(200, { verdict: "allow" });
      send(402, { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0xabc", amount: "10000" }] });
    });
  });
  await new Promise<void>((ok) => server.listen(47851, "127.0.0.1", ok));
  try {
    const r = await payX402("http://127.0.0.1:47851/api/check", 0.05, { method: "POST", body: '{"payoutAddress":"a.near"}' });
    assert.equal(r.ok, true, r.note);
    assert.deepEqual(seen.map((s) => [s.method, s.body, s.paid]), [["POST", '{"payoutAddress":"a.near"}', false], ["POST", '{"payoutAddress":"a.near"}', true]]);
  } finally {
    server.close();
  }
});

test("with X402_TESTNET and a receiving address, Check is sold through the x402.org test facilitator, with fixed requirements", async () => {
  const f = facilitator()!;
  assert.equal(f.version, 2);
  assert.match(f.name, /x402\.org/);
  const r = await f.requirements("https://x.example/api/check");
  assert.deepEqual([r.network, r.amount, r.payTo, r.asset], ["eip155:84532", "10000", "0x1111111111111111111111111111111111111111", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"]);
  assert.equal(f.forPayment, undefined, "fixed requirements need no per-payment lookup");
});

test("the 402 carries the v2 PAYMENT-REQUIRED header, and a payment x402.org rejects stops the check", async () => {
  await withFetch((url) => (url.endsWith("/verify") ? json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" }) : json({}, 404)), async (calls) => {
    const call = (h: Record<string, string> = {}) => checkRoute(new Request("https://b.example/api/check", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ payoutAddress: "wrap.near" }) }), undefined) as Promise<Response>;
    const first = await call();
    assert.equal(first.status, 402);
    const header = JSON.parse(Buffer.from(first.headers.get("payment-required")!, "base64").toString()) as { accepts: { payTo: string }[] };
    assert.equal(header.accepts[0].payTo, "0x1111111111111111111111111111111111111111");
    const second = await call({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64") });
    assert.equal(second.status, 402);
    assert.match(((await second.json()) as { error: string }).error, /insufficient_balance/);
    assert.ok(calls.some((c) => c.url === "https://x402.org/facilitator/verify"));
    assert.ok(!calls.some((c) => c.url.endsWith("/settle")), "nothing was settled");
  });
});
