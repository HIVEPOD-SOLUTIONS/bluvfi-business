import { PAYER_KEY, PAYER_PORT, PAYER_TOKEN } from "./setup-x402";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { payX402 } from "../../lib/rails";
import { createPayer } from "../../lib/x402-payer";
import { evmAddress, signExactEvm, type ExactEvmRequirements } from "../../lib/x402-signer";

/**
 * The agent's x402 spending against the real x402.org test API (Base Sepolia, free test USDC) and its real facilitator. If the payer's
 * wallet holds test USDC, the payment really goes through; if it does not, the real API says so, which still proves everything up to
 * settlement. Fund it for free with `npm run x402:payer -- setup` and https://faucet.circle.com.
 */
const T = { timeout: 120_000 };
const URL_ = "https://x402.org/protected";
const SEPOLIA_RPC = "https://sepolia.base.org";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const requirements = async () => {
  const res = await fetch(URL_);
  assert.equal(res.status, 402);
  const required = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString()) as { accepts: ExactEvmRequirements[]; resource?: unknown };
  return { accept: required.accepts.find((a) => a.network === "eip155:84532")!, resource: required.resource };
};

const balance = async () => {
  const data = `0x70a08231${evmAddress(PAYER_KEY).slice(2).toLowerCase().padStart(64, "0")}`;
  const r = await fetch(SEPOLIA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SEPOLIA_USDC, data }, "latest"] }) });
  return Number(BigInt(((await r.json()) as { result?: string }).result ?? "0x0")) / 1e6;
};

let server: Server;
const signed: { status: number; usd?: number }[] = [];
before(async () => {
  const payer = createPayer({ privateKey: PAYER_KEY, testnet: true, maxPaymentUsd: 0.05, maxDayUsd: 5, token: PAYER_TOKEN });
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const out = await payer.pay(JSON.parse(raw || "{}"), req.headers.authorization);
      signed.push({ status: out.status, usd: out.body.usd });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((ok) => server.listen(PAYER_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });

test("the real x402.org API describes its price in the v2 header, and the real facilitator accepts our signature", T, async () => {
  const { accept, resource } = await requirements();
  assert.equal(accept.scheme, "exact");
  assert.equal(accept.amount, "10000", "0.01 USDC");
  const signedPayment = await signExactEvm(accept, PAYER_KEY, { resource });
  const payload = JSON.parse(Buffer.from(signedPayment.paymentHeader, "base64").toString()) as { payload: { signature: string } };
  const verify = async (p: unknown) => (await (await fetch("https://x402.org/facilitator/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: p, paymentRequirements: accept }) })).json()) as { isValid: boolean; invalidReason?: string };

  const ok = await verify(JSON.parse(Buffer.from(signedPayment.paymentHeader, "base64").toString()));
  if (await balance() >= 0.01) assert.equal(ok.isValid, true, "funded: the facilitator says the payment is valid");
  // Unfunded, the only thing wrong is the balance: the signature, the amount, the address and the window are all accepted.
  else assert.equal(ok.invalidReason, "invalid_exact_evm_insufficient_balance");

  // A corrupted signature reads differently, so the line above really is the signature being right.
  payload.payload.signature = payload.payload.signature.slice(0, -4) + "0000";
  const bad = await verify({ ...JSON.parse(Buffer.from(signedPayment.paymentHeader, "base64").toString()), payload: { ...JSON.parse(Buffer.from(signedPayment.paymentHeader, "base64").toString()).payload, signature: payload.payload.signature } });
  assert.equal(bad.isValid, false);
  assert.equal(bad.invalidReason, "invalid_exact_evm_signature");
});

test("the agent pays the real API through the payer: it signs within its limits and the API answers, and with a funded wallet it is paid for", T, async () => {
  const funded = (await balance()) >= 0.01;
  const r = await payX402(URL_, 0.05);
  assert.equal(r.priceUsd, 0.01, "the price was read from the v2 header");
  assert.deepEqual(signed.at(-1), { status: 200, usd: 0.01 }, "the payer signed exactly $0.01, within its limits");
  if (funded) {
    assert.equal(r.ok, true, r.note);
    assert.equal(r.status, 200);
    assert.ok(r.body, "the protected content came back");
    assert.equal(r.note, "Paid and delivered.");
  } else {
    // No test USDC in the wallet: the real API refuses the unfunded payment. Nothing moved.
    assert.equal(r.ok, false);
    assert.equal(r.status, 402);
    assert.match(r.note, /did not deliver/);
  }
});

test("the agent's own cap is checked before the payer is even asked", T, async () => {
  const before = signed.length;
  const r = await payX402(URL_, 0.005); // the API wants $0.01
  assert.equal(r.ok, false);
  assert.match(r.note, /exceeds the allowed \$0\.005/);
  assert.equal(signed.length, before, "the payer was never asked to sign");
});
