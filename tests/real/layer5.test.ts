import "./setup-layer4";
import assert from "node:assert/strict";
import { test } from "node:test";

// Layer 5 against the real NEAR AI Cloud privacy filter (inside its TEE gateway). Needs NEAR_AI_API_KEY (from .env.local or the shell).
const T = { timeout: 120_000, ...(process.env.NEAR_AI_API_KEY ? {} : { skip: "needs NEAR_AI_API_KEY" }) };

test("the real privacy filter strips a person's details before any reasoning call, and the record says it ran", T, async () => {
  const { redact } = await import("../../lib/redact");
  const original = "Invoice 2207 from Jane Doe of Acme Supplies. Contact jane.doe@acme-supplies.example or +1 415 555 0100. Pay IBAN GB82WEST12345698765432, or wallet 0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912 (acme-pay.near). Telegram @janedoe_acme. Amount 1,200 USDC.";
  const r = await redact(original);
  assert.equal(r.source, "near-ai+local-regex", r.note);
  for (const secret of ["jane.doe@acme-supplies.example", "415 555 0100", "GB82WEST12345698765432", "0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912", "acme-pay.near", "@janedoe_acme"]) assert.ok(!r.text.includes(secret), `${secret} survived: ${r.text}`);
  assert.ok(!/Jane Doe/.test(r.text), `the name survived: ${r.text}`);
  assert.match(r.text, /1,200 USDC/, "the amount, which the reviewer needs, is kept");
});

test("a response the filter cannot give is never mistaken for a clean one: local patterns run and the record says so", T, async () => {
  const { redact } = await import("../../lib/redact");
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("/privacy/redact") ? new Response("{}", { status: 503 }) : real(url, init))) as typeof fetch;
  try {
    const r = await redact("Pay jane@acme.example 100 USDC");
    assert.equal(r.source, "local-regex");
    assert.match(r.note ?? "", /unavailable/);
    assert.ok(!r.text.includes("jane@acme.example"));
  } finally {
    globalThis.fetch = real;
  }
});
