import "./setup";
import "./setup-outlayer";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { checkSettlement, processInvoice } from "../lib/agent";
import { checkCustody, resetCustodyCache } from "../lib/custody";
import { install, invoice, seed, state } from "./fakes";

beforeEach(() => {
  install();
  seed();
  state().payments.push({ status: "paid", createdAt: "2026-10-01T00:00:00.000Z", invoice: { payoutAddress: "northwind.near", amountUsd: 0 } } as never);
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function withOutlayer(routes: Record<string, (body: unknown) => Response>, body: (calls: { path: string; body: unknown; headers: Record<string, string> }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const b = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body: b, headers: (init?.headers ?? {}) as Record<string, string> });
    const h = routes[path];
    return h ? h(b) : json({ error: "not_found" }, 404);
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const POLICY = json({ wallet_id: "w1", controller: "acme.near", frozen: false, policy: "stored", rules: { limits: { per_transaction: { "*": "5000000000" }, daily: { "*": "10000000000" } } }, approval: { threshold: { required: 2 } } });

test("outlayer: a wallet without a policy is unrestricted, so the app refuses to use it", async () => {
  await withOutlayer({ "/wallet/v1/policy": () => json({ wallet_id: "w1", controller: "acme.near", frozen: false, policy: "none" }) }, async () => {
    const c = await checkCustody();
    assert.equal(c.ok, false);
    assert.match(c.problems.join(" "), /no policy/);
  });
});

test("outlayer: a payout over the wallet's limit is refused by OutLayer's policy and the payment is blocked", async () => {
  await withOutlayer({
    "/wallet/v1/policy": () => POLICY,
    "/wallet/v1/storage-deposit": () => json({ status: "already_registered" }),
    "/wallet/v1/call": () => json({ error: "policy_denied", message: "per_transaction limit exceeded" }, 403),
  }, async (calls) => {
    const p = await processInvoice(invoice({ invoiceNumber: "INV-OL1" }));
    assert.equal(p.status, "blocked");
    assert.equal(p.headline, "Blocked by the custodian");
    assert.match(p.reason, /policy_denied/);
    const call = calls.find((c) => c.path === "/wallet/v1/call")!;
    assert.equal((call.body as { method_name: string }).method_name, "ft_transfer");
    assert.equal(call.headers["X-Idempotency-Key"], `bluvfi-${p.id}`);
    assert.match((call.body as { args: { memo: string } }).args.memo, /^bluvfi:[0-9a-f]{32}$/);
  });
});

test("outlayer: multisig approval, then execution, then 1Click delivery", async () => {
  let reqStatus = "pending_approval";
  await withOutlayer({
    "/wallet/v1/policy": () => POLICY,
    "/wallet/v1/storage-deposit": () => json({ status: "success" }),
    "/wallet/v1/call": () => json({ request_id: "req-1", status: "pending_approval", approval_id: "ap-1", required: 2, approved: 0 }),
    "/wallet/v1/requests/req-1": () => json({ request_id: "req-1", status: reqStatus, tx_hash: reqStatus === "success" ? "OLTX" : undefined }),
  }, async () => {
    const p = await processInvoice(invoice({ invoiceNumber: "INV-OL2" }));
    assert.equal(p.status, "proposed", p.reason);
    assert.match(p.custody!.detail, /0 of 2/);
    await checkSettlement(p.id);
    assert.equal(p.status, "proposed");
    reqStatus = "success";
    await checkSettlement(p.id);
    assert.equal(p.status, "paid");
    assert.equal(p.custody!.txHash, "OLTX");
  });
});

test("outlayer: by default a wallet without its own daily limit is refused, since the API key can spend up to OutLayer's limits", async () => {
  resetCustodyCache();
  await withOutlayer({
    "/wallet/v1/policy": () => json({ wallet_id: "w1", controller: "acme.near", frozen: false, policy: "stored", rules: { limits: { per_transaction: { "*": "5000000000" } } } }),
  }, async () => {
    const c = await checkCustody();
    assert.equal(c.ok, false);
    assert.match(c.problems.join(" "), /no daily limit .* REQUIRE_CUSTODIAN_LIMITS is on/);
  });
});
