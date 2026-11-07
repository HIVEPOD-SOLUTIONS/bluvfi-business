import "./setup-layer3";
import assert from "node:assert/strict";
import { test } from "node:test";

// The card purchase's server side against the REAL NEAR Intents: a real deposit address on Base for a funding into a real mainnet account.
// Nothing is sent to it. (The card flow itself is Privy's: it needs a person and a real card, so it is not run here.)
const T = { timeout: 120_000 };

test("a real funding link for a card purchase gets a real Base deposit address and an amount a little above the purchase", T, async () => {
  const { POST } = await import("../../app/api/fund/card/route");
  const { issueSession } = await import("../../lib/session");
  const { state } = await import("../../lib/store");
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const res = await POST(new Request("https://x.example/api/fund/card", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ amountUsd: 25, refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }) }), undefined);
  const j = (await res.json()) as { error?: string; deposit: { chain: string; address: string; amountIn: string; deadline?: string }; buyUsdc: number; receivable: { id: string; payTo: string } };
  assert.equal(res.status, 200, j.error);
  assert.equal(j.deposit.chain, "base");
  assert.match(j.deposit.address, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(j.buyUsdc >= 25 && j.buyUsdc < 25 * 1.05, `buy ${j.buyUsdc} USDC for a $25 funding`);
  assert.ok(j.deposit.deadline && Date.parse(j.deposit.deadline) > Date.now());
  assert.equal(state().receivables[0].id, j.receivable.id);
  assert.equal(j.receivable.payTo, "near");
});
