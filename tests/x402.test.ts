import { X402_PORT } from "./setup-x402";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { NEAR_USDC_CONTRACT } from "../lib/chains";
import { payX402 } from "../lib/rails";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const B64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const url = (path: string) => `http://127.0.0.1:${X402_PORT}${path}`;

let server: Server;
let payerCalls: { url: string; requirements: Record<string, unknown> }[] = [];
let paidHeaders: Record<string, string | string[] | undefined>[] = [];
let payerStatus = 200;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.url === "/payer/pay") {
        payerCalls.push(JSON.parse(raw));
        return payerStatus === 200 ? json(200, { paymentHeader: "signed-payment-header" }) : json(payerStatus, {});
      }
      const paid = req.headers["x-payment"] || req.headers["payment-signature"];
      if (paid) {
        paidHeaders.push(req.headers);
        return json(200, { verdict: "allow" });
      }
      // x402 v1: the requirements are in the JSON body, the price is maxAmountRequired.
      if (req.url === "/v1/cheap") return json(402, { x402Version: 1, accepts: [{ scheme: "exact", network: "near", asset: NEAR_USDC_CONTRACT, payTo: "api.near", maxAmountRequired: "10000" }] });
      // x402 v2: the requirements are in the PAYMENT-REQUIRED header, the price is `amount`.
      if (req.url === "/v2/cheap") return json(402, {}, { "payment-required": B64({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0xabc", amount: "10000" }] }) });
      if (req.url === "/v2/body") return json(402, { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0xabc", amount: "10000" }] });
      if (req.url === "/v2/dear") return json(402, { accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0xabc", amount: "5000000" }] });
      if (req.url === "/v2/no-price") return json(402, { accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0xabc" }] });
      if (req.url === "/v2/junk-price") return json(402, { accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0xabc", amount: "free" }] });
      if (req.url === "/v2/other-asset") return json(402, { accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x1111111111111111111111111111111111111111", payTo: "0xabc", amount: "10000" }] });
      if (req.url === "/v2/no-asset") return json(402, { accepts: [{ scheme: "exact", payTo: "0xabc", amount: "10000" }] });
      if (req.url === "/v2/empty") return json(402, {});
      if (req.url === "/free") return json(200, { free: true });
      json(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(X402_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { payerCalls = []; paidHeaders = []; payerStatus = 200; });

test("an API that wants no payment is just called", async () => {
  const r = await payX402(url("/free"), 1);
  assert.deepEqual([r.ok, r.priceUsd, payerCalls.length], [true, 0, 0]);
});

test("an x402 v1 API is paid: the payer signs, and the retry carries the header both server versions read", async () => {
  const r = await payX402(url("/v1/cheap"), 0.05);
  assert.equal(r.ok, true, r.note);
  assert.equal(r.priceUsd, 0.01);
  assert.equal(payerCalls.length, 1);
  assert.equal(payerCalls[0].requirements.maxAmountRequired, "10000");
  assert.equal(paidHeaders[0]["x-payment"], "signed-payment-header");
  assert.equal(paidHeaders[0]["payment-signature"], "signed-payment-header");
});

test("an x402 v2 API is paid too, whether it sends its requirements in the PAYMENT-REQUIRED header or in the body", async () => {
  for (const path of ["/v2/cheap", "/v2/body"]) {
    payerCalls = [];
    const r = await payX402(url(path), 0.05);
    assert.equal(r.ok, true, `${path}: ${r.note}`);
    assert.equal(r.priceUsd, 0.01, path);
    assert.equal(payerCalls[0].requirements.amount, "10000", path);
  }
});

test("the spending cap holds for v2 prices too", async () => {
  const r = await payX402(url("/v2/dear"), 0.05);
  assert.equal(r.ok, false);
  assert.equal(r.priceUsd, 5);
  assert.match(r.note, /exceeds the allowed \$0\.05/);
  assert.equal(payerCalls.length, 0, "the payer was never asked to sign");
});

test("a price that cannot be read never slips past the cap: nothing is signed or paid", async () => {
  for (const path of ["/v2/no-price", "/v2/junk-price"]) {
    const r = await payX402(url(path), 0.05);
    assert.equal(r.ok, false, path);
    assert.match(r.note, /price could not be read/, path);
  }
  assert.equal(payerCalls.length, 0);
});

test("the agent pays in USDC only, and refuses an unknown asset, a missing asset, or a 402 that says nothing", async () => {
  assert.match((await payX402(url("/v2/other-asset"), 1)).note, /USDC only/);
  assert.match((await payX402(url("/v2/no-asset"), 1)).note, /unknown asset/);
  assert.match((await payX402(url("/v2/empty"), 1)).note, /did not say how/);
  assert.equal(payerCalls.length, 0);
});

test("a payer that refuses means nothing is paid, and the error says so", async () => {
  payerStatus = 403;
  await assert.rejects(payX402(url("/v1/cheap"), 1), /x402 payer refused \(403\)/);
  assert.equal(paidHeaders.length, 0, "the API was never called with a payment");
});
