import "./setup";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { createPayer } from "../lib/x402-payer";
import { CHAINS, evmAddress, signExactEvm, type ExactEvmRequirements } from "../lib/x402-signer";

/** The signer and the payer's rules. The signature is checked by recovering its signer with a separate call, as the USDC contract does. */
const KEY = generatePrivateKey();
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const v2 = (over: Partial<ExactEvmRequirements> = {}): ExactEvmRequirements => ({ scheme: "exact", network: "eip155:84532", amount: "10000", asset: SEPOLIA_USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, ...over });
const decode = (header: string) => JSON.parse(Buffer.from(header, "base64").toString()) as { x402Version: number; scheme?: string; network?: string; accepted?: ExactEvmRequirements; resource?: unknown; payload: { signature: `0x${string}`; authorization: Record<string, string> } };

test("an x402 v2 payment is an EIP-3009 authorisation whose signature recovers to the payer, for exactly the amount and the address", async () => {
  const resource = { url: "https://x402.org/protected" };
  const signed = await signExactEvm(v2(), KEY, { resource, nowSec: 1_800_000_000 });
  const body = decode(signed.paymentHeader);
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.accepted, v2(), "v2 carries the requirements it accepted");
  assert.deepEqual(body.resource, resource);
  const a = body.payload.authorization;
  assert.deepEqual([a.from, a.to, a.value], [evmAddress(KEY), PAY_TO, "10000"]);
  assert.deepEqual([a.validAfter, a.validBefore], [String(1_800_000_000 - 600), String(1_800_000_000 + 300)]);
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
  // A separate recovery of the signer from the typed data: what the USDC contract does with the same bytes.
  const recovered = await recoverTypedDataAddress({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: SEPOLIA_USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
    signature: body.payload.signature,
  });
  assert.equal(recovered, evmAddress(KEY));
  // A different amount or address would not recover to the payer: the signature covers both.
  const forged = await recoverTypedDataAddress({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: SEPOLIA_USDC },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(99999999), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
    signature: body.payload.signature,
  });
  assert.notEqual(forged, evmAddress(KEY));
});

test("an x402 v1 payment has the v1 shape, and every payment gets its own nonce", async () => {
  const req: ExactEvmRequirements = { scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", asset: SEPOLIA_USDC, payTo: PAY_TO, extra: { name: "USDC", version: "2" } };
  const one = await signExactEvm(req, KEY);
  const two = await signExactEvm(req, KEY);
  const body = decode(one.paymentHeader);
  assert.deepEqual([one.version, body.x402Version, body.scheme, body.network], [1, 1, "exact", "base-sepolia"]);
  assert.equal(body.accepted, undefined);
  assert.notEqual(body.payload.authorization.nonce, decode(two.paymentHeader).payload.authorization.nonce, "a nonce is never reused");
});

test("the signer refuses anything it was not built for", async () => {
  await assert.rejects(signExactEvm(v2({ network: "eip155:1" }), KEY), /does not sign for the network/);
  await assert.rejects(signExactEvm(v2({ scheme: "upto" }), KEY), /only signs the exact scheme/);
  await assert.rejects(signExactEvm(v2({ asset: "0x1111111111111111111111111111111111111111" }), KEY), /only pays in USDC/);
  await assert.rejects(signExactEvm(v2({ amount: undefined }), KEY), /no readable amount/);
  await assert.rejects(signExactEvm(v2({ amount: "free" }), KEY), /no readable amount/);
  await assert.rejects(signExactEvm(v2({ payTo: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" }), KEY), /no EVM address/);
  assert.deepEqual(Object.keys(CHAINS).sort(), ["base", "base-sepolia", "eip155:8453", "eip155:84532"]);
});

const payer = (over: Partial<Parameters<typeof createPayer>[0]> = {}) => createPayer({ privateKey: KEY, testnet: true, maxPaymentUsd: 0.05, maxDayUsd: 0.1, token: "secret-token", ...over });
/** `auth` null means no Authorization header at all (an omitted argument would take the default, the right secret). */
const ask = (p: ReturnType<typeof payer>, r: ExactEvmRequirements | undefined, auth: string | null = "Bearer secret-token") => p.pay({ url: "https://x402.org/protected", requirements: r }, auth ?? undefined);

test("only the app's shared secret opens the payer", async () => {
  const p = payer();
  assert.equal((await ask(p, v2(), null)).status, 401);
  assert.equal((await ask(p, v2(), "Bearer wrong")).status, 401);
  assert.equal((await ask(p, v2(), "secret-token")).status, 401, "the scheme is part of it");
  assert.equal((await ask(p, v2())).status, 200);
  assert.throws(() => createPayer({ privateKey: KEY, testnet: true, maxPaymentUsd: 1, maxDayUsd: 1, token: "" }), /shared secret/);
});

test("a testnet payer will not sign for mainnet, and a mainnet payer will not sign for testnet", async () => {
  const test = await ask(payer({ testnet: true }), v2({ network: "eip155:8453", asset: BASE_USDC }));
  assert.equal(test.status, 403);
  assert.match(test.body.error!, /testnet mode and will not sign for eip155:8453/);
  const main = await ask(payer({ testnet: false }), v2());
  assert.equal(main.status, 403);
  assert.match(main.body.error!, /mainnet mode/);
  assert.equal((await ask(payer({ testnet: false }), v2({ network: "eip155:8453", asset: BASE_USDC }))).status, 200);
  assert.equal((await ask(payer(), v2({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }))).status, 403);
});

test("the per-payment and daily limits hold, and a refused payment is not counted", async () => {
  const p = payer({ maxPaymentUsd: 0.05, maxDayUsd: 0.06 });
  const dear = await ask(p, v2({ amount: "60000" }));
  assert.equal(dear.status, 403);
  assert.match(dear.body.error!, /over this payer's \$0\.05 limit for one payment/);
  assert.equal(p.spentToday(), 0);
  assert.equal((await ask(p, v2({ amount: "40000" }))).status, 200);
  const over = await ask(p, v2({ amount: "30000" }));
  assert.equal(over.status, 403);
  assert.match(over.body.error!, /daily limit/);
  assert.equal(p.spentToday(), 0.04);
  assert.equal((await ask(p, v2({ amount: "20000" }))).status, 200, "what is left of the day can still be spent");
  assert.equal((await ask(p, v2({ amount: "10000" }))).status, 403);
  assert.equal((await ask(p, v2({ amount: "free" }))).status, 400);
  assert.equal((await ask(p, undefined)).status, 400);
});

test("the day's spending resets at midnight, and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-payer-"));
  const spentFile = join(dir, "spent.json");
  let now = Date.UTC(2026, 10, 4, 10, 0, 0);
  const a = payer({ maxDayUsd: 0.02, spentFile, now: () => now });
  assert.equal((await ask(a, v2({ amount: "20000" }))).status, 200);
  assert.equal((await ask(a, v2({ amount: "10000" }))).status, 403, "the day's limit is used up");
  // A restart the same day does not forget.
  const b = payer({ maxDayUsd: 0.02, spentFile, now: () => now });
  assert.equal(b.spentToday(), 0.02);
  assert.equal((await ask(b, v2({ amount: "10000" }))).status, 403);
  // The next day starts again.
  now = Date.UTC(2026, 10, 5, 0, 0, 1);
  assert.equal(b.spentToday(), 0);
  assert.equal((await ask(b, v2({ amount: "20000" }))).status, 200);
  // A damaged file starts the day empty and is rewritten with the next payment.
  writeFileSync(spentFile, "not json");
  const c = payer({ maxDayUsd: 0.02, spentFile, now: () => now });
  assert.equal((await ask(c, v2({ amount: "10000" }))).status, 200);
  assert.equal(JSON.parse(readFileSync(spentFile, "utf8")).usd, 0.01);
});
