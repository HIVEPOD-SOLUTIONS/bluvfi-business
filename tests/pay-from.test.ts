import "./setup-demo";
import assert from "node:assert/strict";
import { test } from "node:test";
import { POST as payRoute } from "../app/api/pay/[id]/route";
import { createFundingLink } from "../lib/fund";
import { intentsTokens, payFromChains } from "../lib/intents-tokens";

const pay = (id: string, b: unknown) =>
  payRoute(new Request(`https://x.example/api/pay/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), { params: Promise.resolve({ id }) }) as Promise<Response>;

test("pay links offer every chain and token NEAR Intents lists, the usual chains first and USDC first on each", async () => {
  const chains = await payFromChains();
  assert.ok(chains.length >= 30, `${chains.length} chains`);
  assert.deepEqual(chains.slice(0, 5).map((c) => c.chain), ["eth", "base", "arb", "sol", "near"]);
  for (const c of ["btc", "tron", "ton", "bsc", "pol", "op", "avax", "stellar", "xrp", "doge", "sui", "aptos"]) assert.ok(chains.some((x) => x.chain === c), c);
  assert.equal(chains.find((c) => c.chain === "eth")!.tokens[0].symbol, "USDC");
  assert.equal(chains.find((c) => c.chain === "eth")!.name, "Ethereum");
  assert.ok(!(await intentsTokens()).some((t) => /deprecated/i.test(t.symbol)), "deprecated tokens are left out");
});

test("a client can pay a link in Bitcoin; the treasury still receives USDC, and a token 1Click does not list is refused", async () => {
  const link = createFundingLink(500);
  const btc = (await intentsTokens()).find((t) => t.blockchain === "btc" && t.symbol === "BTC")!;
  const res = await pay(link.id, { fromAsset: btc.assetId, refundTo: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });
  const out = (await res.json()) as { quote: { amountIn: string }; receivable: { deposit: { chain: string; symbol: string } } };
  assert.equal(out.receivable.deposit.chain, "btc");
  assert.equal(out.receivable.deposit.symbol, "BTC");
  assert.ok(Number(out.quote.amountIn) > 0 && Number(out.quote.amountIn) < 1, `about $500 of BTC, not 500 BTC: ${out.quote.amountIn}`);

  const bad = await pay(link.id, { fromAsset: "nep141:evil.near", refundTo: "x" });
  assert.match(((await bad.json()) as { error: string }).error, /does not take that token/);

  // The older form (a chain, meaning USDC there) still works for the bank and card funding flows.
  const usdc = (await (await pay(link.id, { fromChain: "base", refundTo: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" })).json()) as { receivable: { deposit: { symbol: string } } };
  assert.equal(usdc.receivable.deposit.symbol, "USDC");
});
