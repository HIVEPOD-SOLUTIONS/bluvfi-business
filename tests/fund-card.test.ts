import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { POST as cardPost } from "../app/api/fund/card/route";
import { services } from "../lib/services";
import { issueSession } from "../lib/session";
import { install, seed, state } from "./fakes";

const DEPOSIT = "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a";
const BUYER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
let asked: { amount: number; chain: string; refundTo: string; payTo: string }[] = [];

beforeEach(() => {
  install(); seed(); asked = [];
  services.quoteReceivable = async (amount: number, chain: string, refundTo: string, payTo: string) => {
    asked.push({ amount, chain, refundTo, payTo });
    return { depositAddress: DEPOSIT, amountIn: (amount * 1.002).toFixed(2), amountOut: amount.toFixed(2), deadline: new Date(Date.now() + 3_600_000).toISOString(), source: "1click" as const };
  };
});
const call = async (b: unknown, signedIn = true) => {
  const cookie: Record<string, string> = signedIn ? { cookie: `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}` } : {};
  return cardPost(new Request("https://x.example/api/fund/card", { method: "POST", headers: { "content-type": "application/json", ...cookie }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
};

test("a card purchase makes a funding link and a Base deposit address for this one purchase, refunding to the buyer's own wallet", async () => {
  const res = await call({ amountUsd: 25, refundTo: BUYER });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { receivable: { id: string; kind: string; deposit: { chain: string; address: string }; payTo: string }; buyUsdc: number };
  assert.deepEqual(asked, [{ amount: 25, chain: "base", refundTo: BUYER, payTo: "treasury.near" }]);
  assert.deepEqual([j.receivable.kind, j.receivable.deposit.chain, j.receivable.deposit.address, j.buyUsdc], ["funding", "base", DEPOSIT, 25.05]);
  assert.equal(state().receivables[0].id, j.receivable.id);
  assert.equal(state().receivables[0].deposit?.address, DEPOSIT);
});

test("it refuses what the card flow cannot do: too small or too large, no buyer wallet, not signed in", async () => {
  for (const amountUsd of [0, 10.99, 5001, "abc"]) assert.equal((await call({ amountUsd, refundTo: BUYER })).status, 400, `rejects ${amountUsd}`);
  for (const refundTo of ["", "near", "0x123", "0xZZZZ6B8D6e6b28E17013A1485E551dEC1ed4C5a", undefined]) assert.equal((await call({ amountUsd: 25, refundTo })).status, 400, `rejects refund ${refundTo}`);
  assert.equal((await call({ amountUsd: 25, refundTo: BUYER }, false)).status, 400, "not signed in");
  assert.equal(asked.length, 0, "no quote was asked for in any of those");
});

test("it does not start a purchase from an answer it cannot trust", async () => {
  services.quoteReceivable = async () => ({ depositAddress: "not-an-address", amountIn: "25.05", amountOut: "25", source: "1click" as const });
  const bad = await call({ amountUsd: 25, refundTo: BUYER });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /usable deposit address/);
  services.quoteReceivable = async () => ({ depositAddress: DEPOSIT, amountIn: "10", amountOut: "25", source: "1click" as const });
  assert.equal((await call({ amountUsd: 25, refundTo: BUYER })).status, 400, "an amount below what was asked for is not trusted");
});
