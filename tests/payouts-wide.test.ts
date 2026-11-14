import "./setup-demo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { POST as invoicePost } from "../app/api/invoices/route";
import { POST as vendorPost } from "../app/api/vendors/route";
import { processInvoice } from "../lib/agent";
import { PAYOUT_ASSETS, PAYOUT_CHAIN_KEYS, payoutChainFromName, sameAddress, validPayoutAddress } from "../lib/chains";
import { validateChanges } from "../lib/governance";
import { payoutAssetId, payoutProblem, payoutRoutes } from "../lib/intents-tokens";
import { parsePayrollCsv } from "../lib/payroll";
import { COOKIE, issueSession } from "../lib/session";
import { currentPolicy, state } from "../lib/store";
import { ASSETS, CHAINS } from "../lib/zk";

const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TRON = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

test("payouts reach every chain NEAR Intents delivers a stablecoin to, and nothing that cannot be checked", async () => {
  const routes = await payoutRoutes();
  assert.ok(routes.length >= 18, `${routes.length} payout chains`);
  for (const c of ["bsc", "pol", "op", "avax", "tron", "ton", "stellar", "sui", "aptos", "gnosis"]) assert.ok(routes.some((r) => r.chain === c), c);
  assert.deepEqual(routes.find((r) => r.chain === "tron")!.assets, ["USDT"]);
  assert.ok(await payoutAssetId("bsc", "USDT"));
  assert.equal(await payoutAssetId("base", "USDT"), undefined, "no USDT route on Base");
  assert.equal(await payoutAssetId("hypercore", "USDC"), undefined, "USDC is listed twice on Hyperliquid: ambiguous, so refused");
  assert.equal(await payoutAssetId("btc", "BTC"), undefined, "payouts are stablecoins only");
  assert.equal(await payoutAssetId("eth", "ETH"), undefined);
});

test("each chain's address format is checked, and an address that differs only in letter case is a different payee where case matters", async () => {
  assert.ok(validPayoutAddress("tron", TRON));
  assert.ok(!validPayoutAddress("tron", EVM));
  assert.ok(validPayoutAddress("bsc", EVM));
  assert.ok(!validPayoutAddress("stellar", "gabc"));
  assert.match((await payoutProblem("tron", "USDT", EVM))!, /is not a Tron address/);
  assert.match((await payoutProblem("btc", "BTC", "bc1q"))!, /not a chain we pay on/);
  assert.equal(await payoutProblem("pol", "USDC", EVM), null);

  assert.ok(sameAddress(EVM, EVM.toLowerCase()), "EVM addresses ignore case");
  assert.ok(!sameAddress(TRON, TRON.toLowerCase()), "Tron (base58) does not");
  assert.ok(!sameAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", "7ecdhsygxxyscszyep35khn8vvw3svaulktzxwcfltv"));
});

test("the zero-knowledge policy codes keep their old values: the payout lists only grow at the end", () => {
  assert.deepEqual(CHAINS.slice(0, 5), ["near", "eth", "arb", "base", "sol"]);
  assert.deepEqual(ASSETS.slice(0, 2), ["USDC", "USDT"]);
  assert.ok(CHAINS.length <= 31 && ASSETS.length <= 31, "the proof's masks hold 31 entries");
  assert.equal(new Set(PAYOUT_CHAIN_KEYS).size, PAYOUT_CHAIN_KEYS.length);
  assert.equal(new Set(PAYOUT_ASSETS).size, PAYOUT_ASSETS.length);
});

test("a vendor on BNB Chain is saved; a wrong address, a chain we cannot pay on and a missing route are refused", async () => {
  const cookie = `${COOKIE}=${encodeURIComponent((await issueSession("maya"))!)}`;
  const save = async (payout: Record<string, string>) => {
    const res = await vendorPost(new Request("https://x.example/api/vendors", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ vendor: { name: "Lotus Data Pte", domain: "lotus.example", verifiedContact: { channel: "email", handle: "ap@lotus.example" }, payout } }),
    }), undefined) as Response;
    return (await res.json()) as { error?: string; vendors?: { name: string; payout: { chain: string; asset: string } }[] };
  };
  assert.match((await save({ chain: "bsc", asset: "USDT", address: TRON })).error!, /not a BNB Chain address/);
  assert.match((await save({ chain: "btc", asset: "BTC", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" })).error!, /not a chain we pay on/);
  assert.match((await save({ chain: "base", asset: "USDT", address: EVM })).error!, /USDT on Base is not a route/);
  const ok = await save({ chain: "BSC", asset: "usdt", address: EVM });
  assert.deepEqual(ok.vendors!.find((v) => v.name === "Lotus Data Pte")!.payout, { chain: "bsc", asset: "USDT", address: EVM });

  const bad = await invoicePost(new Request("https://x.example/api/invoices", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ invoice: { vendorName: "Lotus Data Pte", invoiceNumber: "L-1", amountUsd: 10, chain: "tron", asset: "USDT", payoutAddress: EVM, text: "x" } }),
  }), undefined) as Response;
  assert.match(((await bad.json()) as { error: string }).error, /not a Tron address/);
});

test("a new chain stays off until the council allows it: the policy blocks it, and the policy accepts it once named", async () => {
  const inv = { id: "inv-bsc", vendorName: "Lotus Data Pte", vendorDomain: "lotus.example", vendorContact: { channel: "email" as const, handle: "" }, invoiceNumber: "L-2", poNumber: "", amountUsd: 120, asset: "USDT", chain: "bsc", payoutAddress: EVM, text: "Data services, 120 USDT", receivedAt: new Date().toISOString() };
  const p = await processInvoice(inv);
  const chain = p.checks.find((c) => c.id === "chain")!;
  assert.equal(chain.verdict, "block", chain.reason);
  assert.notEqual(p.status, "ready_to_send");

  const { version, hash, createdAt, ...rest } = currentPolicy();
  void version; void hash; void createdAt;
  validateChanges({ ...rest, allowedChains: [...rest.allowedChains, "bsc", "tron"], allowedAssets: ["USDC", "USDT", "USDT0"] });
  assert.throws(() => validateChanges({ ...rest, allowedChains: ["btc"] }), /Unknown chain "btc"/);
  assert.ok(state().policies.length > 0);
});

test("payroll takes the chain names people write, on any payout chain, and checks each address for its chain", async () => {
  assert.equal(payoutChainFromName("Polygon"), "pol");
  assert.equal(payoutChainFromName("TRC20"), "tron");
  const ok = await parsePayrollCsv(`name,amount,chain,asset,address\nAda,100,Polygon,USDC,${EVM}\nBo,200,Tron,USDT,${TRON}\nCy,300,BNB,USDT,${EVM}`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rows.map((r) => r.chain), ["pol", "tron", "bsc"]);
  const bad = await parsePayrollCsv(`name,amount,chain,asset,address\nAda,100,Tron,USDT,${EVM}\nBo,100,Dogecoin,USDT,D8x`);
  assert.match(bad.errors[0], /is not a Tron address/);
  assert.match(bad.errors[1], /"Dogecoin" is not a chain we pay on/);
});

test("one signer cannot redirect an existing vendor's money: the change waits for a second signer", async () => {
  const as = async (who: string) => `${COOKIE}=${encodeURIComponent((await issueSession(who))!)}`;
  const post = async (who: string, b: unknown) => {
    const res = await vendorPost(new Request("https://x.example/api/vendors", { method: "POST", headers: { "content-type": "application/json", cookie: await as(who) }, body: JSON.stringify(b) }), undefined) as Response;
    return (await res.json()) as { error?: string; vendors?: { name: string; payout: { address: string }; pendingChange?: { by: string } }[] };
  };
  const vendor = (address: string) => ({ vendor: { name: "Quill Legal LLP", domain: "quill.example", verifiedContact: { channel: "email", handle: "ap@quill.example" }, payout: { chain: "eth", asset: "USDC", address } } });
  const NEW = "0x1111111111111111111111111111111111111111";
  await post("maya", vendor(EVM));
  const changed = await post("maya", vendor(NEW));
  const q = changed.vendors!.find((v) => v.name === "Quill Legal LLP")!;
  assert.equal(q.payout.address, EVM, "payments still go to the old address");
  assert.equal(q.pendingChange?.by, "maya");
  assert.match((await post("maya", { confirmChange: "Quill Legal LLP" })).error!, /different signer/);
  const ok = await post("devon", { confirmChange: "Quill Legal LLP" });
  assert.equal(ok.vendors!.find((v) => v.name === "Quill Legal LLP")!.payout.address, NEW);
});
