import "./setup-layer4";
import { PAYER_KEY, PAYER_PORT, PAYER_TOKEN } from "./setup-x402";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Layer 4 against the real services, nothing faked:
//  - the payee's on-chain facts, from the real NEAR RPC, archive node and NearBlocks;
//  - the voice callback's speech-to-text, on the real Whisper model on NEAR AI Cloud (needs NEAR_AI_API_KEY; skipped without);
//  - Bluvfi Business Check sold per call over x402 and paid for with the real payer, settled by the real x402.org facilitator on Base Sepolia.
// Set before the app's modules load, because the app reads its settings once.
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
process.env.X402_PAYTO_EVM = PAY_TO;
delete process.env.PINGPAY_API_KEY;
delete process.env.X402_FACILITATOR_URL;

const T = { timeout: 180_000 };
const SEPOLIA_RPC = "https://sepolia.base.org";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const balanceOf = async (address: string) => {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const r = await fetch(SEPOLIA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SEPOLIA_USDC, data }, "latest"] }) });
  return Number(BigInt(((await r.json()) as { result?: string }).result ?? "0x0")) / 1e6;
};

test("the payee's on-chain facts are real: an old contract, a missing account, and what changed in 30 days", T, async () => {
  const { lookupSignals } = await import("../../lib/chain");
  const wrap = await lookupSignals("wrap.near", "near");
  assert.equal(wrap?.isContract, true);
  assert.equal(typeof wrap?.ageDays, "number");
  assert.ok(wrap!.ageDays! > 365, `wrap.near is years old, got ${wrap?.ageDays}`);
  assert.equal(wrap?.codeChangedRecently, false, "wrap.near runs the same code as 30 days ago, read from an archive node");

  const ghost = await lookupSignals(`nobody-${Date.now()}.near`, "near");
  assert.equal(ghost?.ageDays, 0);
  assert.equal(ghost?.isContract, false);

  const evm = await lookupSignals("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "eth"); // USDC on Ethereum
  assert.equal(evm?.isContract, true);
});

test("the fraud engine scores a brand-new payee badly and an established one cleanly, from real chain data", T, async () => {
  const { publicCheck } = await import("../../lib/agent");
  const fresh = await publicCheck({ payoutAddress: `fresh-${Date.now()}.near`, chain: "near", vendorName: "Unknown Co", vendorDomain: "unknown.example" });
  const counterparty = fresh.checks.find((c) => c.id === "counterparty")!;
  assert.notEqual(counterparty.verdict, "allow", counterparty.reason);

  const old = await publicCheck({ payoutAddress: "wrap.near", chain: "near", vendorName: "Wrap", vendorDomain: "wrap.example" });
  assert.equal(old.checks.find((c) => c.id === "counterparty")!.verdict, "allow");
});

const speak = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "bluvfi-voice-"));
  const file = join(dir, "answer.wav");
  execFileSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:VOICE_FILE); $s.Speak($env:VOICE_TEXT); $s.Dispose()"], { env: { ...process.env, VOICE_FILE: file, VOICE_TEXT: text } });
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const voice = process.platform === "win32" && process.env.NEAR_AI_API_KEY ? {} : { skip: "needs Windows speech synthesis and NEAR_AI_API_KEY" };

test("a spoken answer is transcribed by the real Whisper model on NEAR AI and read correctly", { ...T, ...voice }, async () => {
  const { transcribeAudio, spokenAnswer } = await import("../../lib/transcribe");
  const no = await transcribeAudio(speak("No. That was not us. Please do not pay that invoice."));
  assert.match(no.toLowerCase(), /not us/);
  assert.equal(spokenAnswer(no), "no");
  const yes = await transcribeAudio(speak("Yes, that was us. Please go ahead."));
  assert.match(yes.toLowerCase(), /yes/);
  assert.equal(spokenAnswer(yes), "yes");
});

let payer: Server;
let checkServer: Server;
let checkUrl = "";
before(async () => {
  const { createPayer } = await import("../../lib/x402-payer");
  const p = createPayer({ privateKey: PAYER_KEY, testnet: true, maxPaymentUsd: 0.05, maxDayUsd: 5, token: PAYER_TOKEN });
  payer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const out = await p.pay(JSON.parse(raw || "{}"), req.headers.authorization);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((ok) => payer.listen(PAYER_PORT, "127.0.0.1", ok));

  // Bluvfi Business Check itself: the real route handler behind a plain HTTP server.
  const { POST } = await import("../../app/api/check/route");
  checkServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = (await POST(new Request(`http://${req.headers.host}${req.url}`, { method: "POST", headers, body: Buffer.concat(chunks) }), undefined)) as Response;
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
  await new Promise<void>((ok) => checkServer.listen(0, "127.0.0.1", ok));
  checkUrl = `http://127.0.0.1:${(checkServer.address() as { port: number }).port}/api/check`;
});
after(() => { payer.close(); checkServer.close(); });

const body = JSON.stringify({ payoutAddress: "wrap.near", chain: "near", vendorName: "Wrap", vendorDomain: "wrap.example" });

test("Check refuses an unpaid call and says what it costs, in the v2 header and the body", T, async () => {
  const r = await fetch(checkUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(r.status, 402);
  const header = JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString()) as { x402Version: number; accepts: { network: string; amount: string; payTo: string }[] };
  const json = (await r.json()) as typeof header;
  for (const o of [header, json]) {
    assert.equal(o.x402Version, 2);
    assert.deepEqual([o.accepts[0].network, o.accepts[0].amount, o.accepts[0].payTo], ["eip155:84532", "10000", PAY_TO]);
  }
});

test("Check is paid for for real: the agent's payer signs, x402.org verifies and settles on Base Sepolia, and the verdict comes back with the transaction", T, async () => {
  const { payX402 } = await import("../../lib/rails");
  const { evmAddress } = await import("../../lib/x402-signer");
  const payerBalance = await balanceOf(evmAddress(PAYER_KEY));
  if (payerBalance < 0.01) return console.log("  (payer wallet has no test USDC: fund it at https://faucet.circle.com; the unpaid and refusal tests above still ran)");

  const r = await payX402(checkUrl, 0.05, { method: "POST", body });
  assert.equal(r.ok, true, r.note);
  assert.equal(r.priceUsd, 0.01);
  const out = r.body as { verdict: string; checks: unknown[]; payment: { facilitator: string; transaction: string } };
  assert.ok(["allow", "warn", "block"].includes(out.verdict));
  assert.ok(out.checks.length >= 4);
  assert.match(out.payment.transaction, /^0x[0-9a-f]{64}$/i, "a real Base Sepolia transaction");

  // The money really moved: the receiving address now holds the 0.01 test USDC.
  let got = 0;
  for (let i = 0; i < 20 && got < 0.01; i++) { got = await balanceOf(PAY_TO); if (got < 0.01) await new Promise((ok) => setTimeout(ok, 2000)); }
  assert.equal(got, 0.01);
});

test("a forged payment is refused before any check runs or money moves", T, async () => {
  const r = await fetch(checkUrl, { method: "POST", headers: { "content-type": "application/json", "x-payment": Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: {} } })).toString("base64") }, body });
  assert.equal(r.status, 402);
  assert.match(((await r.json()) as { error: string }).error, /Payment not valid/);
  assert.equal(await balanceOf(PAY_TO) <= 0.01, true);
});
