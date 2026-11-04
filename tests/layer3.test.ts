import { CRON } from "./setup-layer3";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as poll } from "../app/api/settlement/poll/route";
import { approve, processInvoice, recordSent } from "../lib/agent";
import { createBusiness, resetRegistry } from "../lib/business";
import { payoutWindowMs } from "../lib/custody";
import { refreshReceivable } from "../lib/receivables";
import { pollAllBusinesses, pollSettlements } from "../lib/settlement";
import { resetAllState } from "../lib/store";
import { runAs } from "../lib/tenant";
import type { Receivable } from "../lib/types";
import { behaviour, depositsSubmitted, install, invoice, quoteWindows, seed, state } from "./fakes";

beforeEach(() => {
  resetAllState();
  resetRegistry();
  install();
  seed();
  // A prior payment so the counterparty is known and a clean invoice goes through to release.
  state().payments.push({ status: "paid", createdAt: "2026-10-01T00:00:00.000Z", invoice: { payoutAddress: "northwind.near", amountUsd: 0 } } as never);
});

const receivable = (over: Partial<Receivable> = {}): Receivable => ({
  id: "rcv-1", client: "Zed", description: "", amountUsd: 50, asset: "USDC", chain: "near", payTo: "treasury.near", createdAt: new Date().toISOString(), status: "open",
  deposit: { chain: "eth", address: "dep-rcv-1", amountIn: "50.10", deadline: new Date(Date.now() + 3_600_000).toISOString() },
  ...over,
});

test("a payout the treasury sends by hand gets a day to arrive, and the deposit is reported to 1Click with its hash", async () => {
  assert.equal(await payoutWindowMs(), 24 * 3_600_000);
  const p = await processInvoice(invoice({ invoiceNumber: "INV-MAN" }));
  const held = p.status === "held" || p.status === "awaiting_approval";
  const sent = held ? await approve(p.id, "maya") : p;
  assert.equal(sent.status, "ready_to_send", sent.reason);
  assert.deepEqual(quoteWindows, [24 * 3_600_000]);

  const after = recordSent(p.id, "maya", "7xK9sentTxHash");
  assert.equal(after.txRef, "7xK9sentTxHash");
  await new Promise((r) => setTimeout(r, 20)); // the report to 1Click is fire-and-forget
  assert.deepEqual(depositsSubmitted, [{ txHash: "7xK9sentTxHash", depositAddress: "dep-INV-MAN" }]);
});

test("a payment link follows 1Click through every status: paid, in flight, short, refunded and expired", async () => {
  const status = async (swap: string, r: Receivable) => {
    behaviour.swap = swap;
    return refreshReceivable(r);
  };

  const paid = receivable();
  assert.equal((await status("SUCCESS", paid)).status, "SUCCESS");
  assert.equal(paid.status, "paid");

  const flight = receivable();
  assert.match((await status("PROCESSING", flight)).note, /delivering it/);
  assert.equal(flight.status, "open");
  assert.ok(flight.deposit, "still waiting: the deposit is kept");

  const short = receivable();
  assert.match((await status("INCOMPLETE_DEPOSIT", short)).note, /less than the amount shown/);
  assert.ok(short.deposit);

  const refunded = receivable();
  const out = await status("REFUNDED", refunded);
  assert.equal(out.status, "REFUNDED");
  assert.match(out.note, /refunded to your refund address/);
  assert.equal(refunded.deposit, undefined, "a dead deposit is cleared so the client can ask again");
  assert.equal(refunded.status, "open");

  const failed = receivable();
  assert.match((await status("FAILED", failed)).note, /could not be completed/);
  assert.equal(failed.deposit, undefined);

  const expired = receivable({ deposit: { chain: "eth", address: "dep-old", amountIn: "50", deadline: new Date(Date.now() - 60_000).toISOString() } });
  const gone = await status("PENDING_DEPOSIT", expired);
  assert.equal(gone.status, "EXPIRED");
  assert.equal(expired.deposit, undefined);

  await assert.rejects(refreshReceivable(receivable({ deposit: undefined })), /No payment has been started/);
});

test("the settlement pass settles what is open, and one failure does not stop the rest", async () => {
  state().receivables.push(receivable({ id: "rcv-a" }), receivable({ id: "rcv-b" }), receivable({ id: "rcv-done", status: "paid" }));
  const p = await processInvoice(invoice({ invoiceNumber: "INV-SET" }));
  if (p.status !== "ready_to_send") await approve(p.id, "maya");
  behaviour.swap = "SUCCESS";
  const pass = await pollSettlements();
  assert.deepEqual(pass.receivables.map((r) => [r.id, r.status]), [["rcv-a", "SUCCESS"], ["rcv-b", "SUCCESS"]]);
  assert.deepEqual(pass.payments, [{ id: p.id, status: "paid" }]);
  assert.deepEqual(pass.errors, []);
  assert.equal(state().receivables.filter((r) => r.status === "paid").length, 3);

  // A status call that throws for one invoice is reported, and the next is still checked.
  state().receivables.push(receivable({ id: "rcv-x", deposit: { chain: "eth", address: "boom", amountIn: "1" } }), receivable({ id: "rcv-y" }));
  const { services } = await import("../lib/services");
  const real = services.swapStatus;
  services.swapStatus = async (address: string) => {
    if (address === "boom") throw new Error("1Click is down");
    return "SUCCESS";
  };
  try {
    const again = await pollSettlements();
    assert.deepEqual(again.errors, ["rcv-x: 1Click is down"]);
    assert.deepEqual(again.receivables, [{ id: "rcv-y", status: "SUCCESS" }]);
  } finally {
    services.swapStatus = real;
  }
});

test("a scheduler with the platform secret settles every business, each in its own records; a signer only their own", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  state().receivables.push(receivable({ id: "rcv-default" }));
  runAs(a.id, () => state().receivables.push(receivable({ id: "rcv-acme" })));
  runAs(b.id, () => state().receivables.push(receivable({ id: "rcv-bolt", deposit: undefined })));
  behaviour.swap = "SUCCESS";

  const call = (headers: Record<string, string>) => poll(new Request("http://app.test/api/settlement/poll", { method: "POST", headers: { "x-forwarded-for": `10.9.0.${Math.floor(Math.random() * 250)}`, ...headers } }), undefined);
  assert.equal((await call({})).status, 400, "no secret and no session");
  assert.equal((await call({ authorization: `Bearer ${CRON.replace("0", "9")}` })).status, 400, "the wrong secret");

  const res = await call({ authorization: `Bearer ${CRON}` });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { businesses: Record<string, { receivables: { id: string }[] }> };
  assert.deepEqual(Object.keys(body.businesses).sort(), ["default", a.id, b.id].sort());
  assert.deepEqual(body.businesses.default.receivables.map((r) => r.id), ["rcv-default"]);
  assert.deepEqual(body.businesses[a.id].receivables.map((r) => r.id), ["rcv-acme"]);
  assert.deepEqual(body.businesses[b.id].receivables, [], "a link with no deposit started has nothing to settle");
  assert.equal(runAs(a.id, () => state().receivables[0].status), "paid");
  assert.equal(runAs(b.id, () => state().receivables[0].status), "open");
  assert.deepEqual(Object.keys(await pollAllBusinesses()).length, 3);
});
