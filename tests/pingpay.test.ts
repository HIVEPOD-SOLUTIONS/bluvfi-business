import "./setup";
import "./setup-pingpay";
import assert from "node:assert/strict";
import { test } from "node:test";
import { POST as checkRoute } from "../app/api/check/route";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const call = (headers: Record<string, string> = {}) =>
  checkRoute(new Request("https://bluvfi-business.example/api/check", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ payoutAddress: "0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912" }) }), undefined) as Promise<Response>;

async function withFetch(handler: (url: string, init?: RequestInit) => Response, body: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
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

// Shapes from PingPay's x402 integration docs, as staging.pingpay.io answers /supported.
const SUPPORTED = { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453", extra: { settlementBackend: "near-intents" } }], extensions: [], signers: {} };
const PREPARED = {
  payTo: "0xBaseDeposit000000000000000000000000000001", amount: "10021", minAmountIn: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  network: "eip155:8453", scheme: "exact", maxTimeoutSeconds: 300, expiresAt: "2026-11-01T12:00:00Z", refundTo: "0xRefund", agentPayChallengeId: "apc_1",
};

test("pingpay: a host that does not serve the facilitator (HTML at /supported) is refused, nothing is prepared", async () => {
  await withFetch((url) => (url.endsWith("/supported") ? new Response("<!DOCTYPE html><html></html>", { headers: { "content-type": "text/html" } }) : json({}, 404)), async (calls) => {
    const res = await call();
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not served there/);
    assert.ok(!calls.some((c) => c.url.endsWith("/prepare")));
  });
});

test("pingpay: 402 carries the prepared challenge; verify and settle use x402 v2 with the API key; verdict after settlement", async () => {
  await withFetch((url) => {
    if (url.endsWith("/supported")) return json(SUPPORTED);
    if (url.endsWith("/prepare")) return json(PREPARED);
    if (url.endsWith("/verify")) return json({ isValid: true, payer: "0xPayer" });
    if (url.endsWith("/settle")) return json({ success: true, transaction: "0xBaseTx", network: "eip155:8453", payer: "0xPayer" });
    return json({}, 404);
  }, async (calls) => {
    const first = await call();
    assert.equal(first.status, 402);
    const j = (await first.json()) as { x402Version: number; accepts: Record<string, unknown>[] };
    assert.equal(j.x402Version, 2);
    assert.equal(j.accepts[0].payTo, PREPARED.payTo);
    assert.equal(j.accepts[0].amount, "10021");
    assert.equal(j.accepts[0].network, "eip155:8453");
    const prep = calls.find((c) => c.url === "https://staging.pingpay.example/agentpay/x402/prepare")!;
    assert.equal((prep.init?.headers as Record<string, string>)["X-Api-Key"], "ping_test");
    assert.equal(JSON.parse(String(prep.init?.body)).amountOut, "10000");

    const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: j.accepts[0], payload: { txHash: "0xBaseTx" } })).toString("base64");
    const paid = await call({ "x-payment": payment });
    assert.equal(paid.status, 200);
    const out = (await paid.json()) as { verdict: string; payment: { transaction: string } };
    assert.equal(out.payment.transaction, "0xBaseTx");
    const settle = calls.find((c) => c.url.endsWith("/settle"))!;
    const sb = JSON.parse(String(settle.init?.body));
    assert.equal(sb.x402Version, 2);
    assert.equal(sb.paymentRequirements.payTo, PREPARED.payTo);
    assert.equal(sb.paymentPayload.payload.txHash, "0xBaseTx");
  });
});
