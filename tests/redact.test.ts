import "./setup-demo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../lib/redact";

test("wallets of every common kind are hidden before the AI reads an invoice: NEAR sub-accounts, implicit accounts, Solana, Tron and Bitcoin", async () => {
  const { text } = await redact(
    `Pay pay.acme.near or ${"3e".repeat(32)}, ` +
      "or 7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV, TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7, bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq. Invoice INV-2026-11 for 4,200.",
  );
  assert.equal(text, "Pay [WALLET] or [WALLET], or [WALLET], [WALLET], [WALLET]. Invoice INV-2026-11 for 4,200.");
});
