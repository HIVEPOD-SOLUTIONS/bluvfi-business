import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../lib/redact";
import { spokenAnswer } from "../lib/transcribe";

test("whisper answers: clear yes and no are understood, anything unclear is left for a human", () => {
  assert.equal(spokenAnswer("Yes, that was us."), "yes");
  assert.equal(spokenAnswer("No. That wasn't us at all."), "no");
  assert.equal(spokenAnswer("Not us"), "no");
  assert.equal(spokenAnswer("Hello? Who is this?"), undefined);
  assert.equal(spokenAnswer("yes no"), undefined);
});

test("redaction: NEAR AI's privacy filter runs first, then the local patterns", async () => {
  const real = globalThis.fetch;
  let sent: { url: string; body: { model: string; input: string } } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ data: [{ index: 0, redacted: "Invoice from [PERSON], pay 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await redact("Invoice from Jane Doe, pay 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    assert.match(sent!.url, /\/privacy\/redact$/);
    assert.equal(sent!.body.model, "openai/privacy-filter");
    assert.equal(r.source, "near-ai+local-regex");
    assert.equal(r.text, "Invoice from [PERSON], pay [WALLET]");
  } finally {
    globalThis.fetch = real;
  }
});

test("redaction: if the privacy filter is down, the local patterns still run and the record says so", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
  try {
    const r = await redact("Mail ap@vendor.example");
    assert.equal(r.source, "local-regex");
    assert.equal(r.text, "Mail [EMAIL]");
    assert.match(r.note ?? "", /unavailable/);
  } finally {
    globalThis.fetch = real;
  }
});

test("aurora widget quotes: the payer picks the token, but amount, USDC on NEAR and the treasury are forced", async () => {
  const { quoteForWidget } = await import("../lib/rails");
  const real = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ quote: { depositAddress: "dep-1", amountIn: "1251000000", amountInFormatted: "1251.00", amountOut: "1250000000" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const q = await quoteForWidget({
      dry: false, swapType: "EXACT_INPUT", amount: "1", originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: "nep141:attacker.near", recipient: "attacker.near", refundTo: "0xPayer", refundType: "ORIGIN_CHAIN", confidentiality: "basic", slippageTolerance: 5000,
    }, 1250, "treasury.near");
    assert.equal(q.depositAddress, "dep-1");
    assert.equal(sent.swapType, "EXACT_OUTPUT");
    assert.equal(sent.amount, "1250000000");
    assert.equal(sent.destinationAsset, "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    assert.equal(sent.recipient, "treasury.near");
    assert.equal(sent.recipientType, "DESTINATION_CHAIN");
    assert.equal(sent.refundTo, "0xPayer");
    assert.equal(sent.confidentiality, "basic");
    assert.equal(sent.slippageTolerance, 300, "slippage is capped");
    await assert.rejects(quoteForWidget({ dry: false, originAsset: "nep141:x" }, 10, "treasury.near"), /refund/);
  } finally {
    globalThis.fetch = real;
  }
});
