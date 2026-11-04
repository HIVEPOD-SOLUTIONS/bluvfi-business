import "./setup-layer3";
import assert from "node:assert/strict";
import { test } from "node:test";
import { payoutWindowMs } from "../../lib/custody";
import { quotePayout, quoteReceivable, submitDeposit, swapStatus } from "../../lib/rails";
import { refreshReceivable } from "../../lib/receivables";
import { pingpaySupported } from "../../lib/x402";
import type { Invoice, Receivable } from "../../lib/types";

/** Layer 3 against the real 1Click API. Quotes are free and unused; nothing here sends funds. */
const T = { timeout: 120_000 };
const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // an established address, as in the Layer 1 real tests
const invoice = (over: Partial<Invoice>): Invoice => ({
  id: "inv", vendorName: "Northwind Cloud", vendorDomain: "northwind.io", vendorContact: { channel: "email", handle: "ap@northwind.io" },
  invoiceNumber: "INV-1", poNumber: "PO-1", amountUsd: 5, asset: "USDC", chain: "eth", payoutAddress: ETH, text: "Hosting.", receivedAt: new Date().toISOString(), ...over,
});

test("a real payout quote carries its deadline and the moment the deposit address stops working, and the address is live", T, async () => {
  const window = await payoutWindowMs();
  assert.equal(window, 24 * 3_600_000, "no DAO here, so a day");
  const q = await quotePayout(invoice({ invoiceNumber: "INV-REAL" }), "public", window);
  assert.equal(q.source, "1click");
  assert.ok(q.depositAddress.length > 10 && !q.depositAddress.startsWith("("), "a real deposit address");
  assert.ok(q.deadline && q.timeWhenInactive, "1Click returned both times");
  // The address must stay valid at least as long as the window we asked for. (1Click also adds a margin of days of its own.)
  assert.ok(new Date(q.timeWhenInactive).getTime() >= Date.now() + window - 60_000, "the address outlasts the window");
  assert.equal(q.deadline, q.timeWhenInactive);

  // The address is known to 1Click and waiting for a deposit.
  assert.equal(await swapStatus(q.depositAddress, q.depositMemo), "PENDING_DEPOSIT");

  // A payment link on that kind of deposit stays open and says so; it is not cleared.
  const r: Receivable = { id: "rcv", client: "c", description: "", amountUsd: 5, asset: "USDC", chain: "near", payTo: "near", createdAt: new Date().toISOString(), status: "open", deposit: { chain: "eth", address: q.depositAddress, memo: q.depositMemo, amountIn: q.amountIn, deadline: q.deadline } };
  const out = await refreshReceivable(r);
  assert.equal(out.status, "PENDING_DEPOSIT");
  assert.match(out.note, /Waiting for your deposit/);
  assert.ok(r.deposit && r.status === "open");

  // Reporting a deposit hash is accepted by the live API (a made-up hash is simply not found on chain yet).
  assert.equal(await submitDeposit("11111111111111111111111111111111111111111111", q.depositAddress, q.depositMemo), true);
});

test("1Click does not know an address it never issued, so a status check fails loudly rather than reporting a payment", T, async () => {
  await assert.rejects(swapStatus("0x0000000000000000000000000000000000000001"), /1Click status failed \(404\)/);
});

test("real payout quotes exist for every chain the policy can allow", T, async () => {
  const dest: [string, string][] = [["near", "near"], ["eth", ETH], ["base", ETH], ["arb", ETH], ["sol", "So11111111111111111111111111111111111111112"]];
  for (const [chain, address] of dest) {
    const q = await quotePayout(invoice({ invoiceNumber: `INV-${chain}`, chain, payoutAddress: address }), "public", 3_600_000);
    assert.ok(q.depositAddress && Number(q.amountIn) >= 5, `${chain}: a priced quote with a deposit address`);
    assert.ok(Number(q.amountIn) < 5.5, `${chain}: the fee is small (${q.amountIn} in for $5 out)`);
  }
});

test("PingPay's facilitator, at the default production host, serves x402 v2 exact on Base, which is what selling Check needs", T, async () => {
  const s = await pingpaySupported();
  assert.equal(s.ok, true, s.note);
});

test("a real payment link can take USDC from every chain the pay page offers", T, async () => {
  for (const chain of ["eth", "base", "arb", "sol", "near"]) {
    const refund = chain === "near" ? "near" : chain === "sol" ? "So11111111111111111111111111111111111111112" : ETH;
    const q = await quoteReceivable(5, chain, refund, "near");
    assert.ok(q.depositAddress && !q.depositAddress.startsWith("("), `${chain}: a deposit address`);
    assert.ok(Number(q.amountIn) >= 5, `${chain}: pays at least the invoice`);
  }
});
