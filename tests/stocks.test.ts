import { BP_PORT, BP_SECRET } from "./setup-stocks";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { GET as stocksGet, POST as stocksPost } from "../app/api/stocks/route";
import { account, depositAddress, fundAccount, listStocks, resetStocks, signature, stockChart, trade } from "../lib/stocks";
import { issueSession } from "../lib/session";
import { currentPolicy } from "../lib/store";
import { install, seed, state } from "./fakes";

const DEPOSIT = "0x4b5Df730c2e6b28E17013A1485E551dEC1ed4C5a";
let server: Server;
let hits: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let open = true;
let fills: object[] = [];
let balances: Record<string, { available: string; locked: string }> = {};

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const json = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(b)); };
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/api/v1/securities") return json(200, [{ asset: "AAPL.US", name: "Apple", sessions: [{ minQuantity: "0.01", stepSize: "0.01" }] }, { asset: "SPY.US", name: "S&P 500 ETF", sessions: [{ minQuantity: "0.01", stepSize: "0.01" }] }]);
      if (u.pathname === "/api/v1/tickers") return json(200, [{ symbol: "AAPL.US_USDC", lastPrice: "200.00", priceChangePercent: "0.0125" }, { symbol: "BTC_USDC", lastPrice: "1", priceChangePercent: "0" }]);
      if (u.pathname === "/api/v1/klines") return json(200, [{ start: "2026-01-01 00:00:00", close: "190" }, { start: "2026-01-02 00:00:00", close: "200" }]);
      if (u.pathname === "/api/v1/market-sessions") return json(200, open ? [{ name: "all", startTime: "00:00:00", endTime: "23:59:59", startWeekday: 1, endWeekday: 7, timezone: "America/New_York" }] : []);
      if (u.pathname === "/api/v1/market-holidays") return json(200, []);
      if (u.pathname === "/api/v1/markets") return json(200, [{ symbol: "AAPL.US_USDC", rwaMarketType: "STOCK", marketType: "SPOT" }]);
      if (u.pathname === "/wapi/v1/capital/deposit/address") return json(200, { address: DEPOSIT });
      if (u.pathname === "/api/v1/capital") return json(200, balances);
      if (u.pathname === "/api/v1/rfq") return json(200, { rfqId: "77", status: "New" });
      if (u.pathname === "/wapi/v1/history/rfq/fill") return json(200, fills);
      if (u.pathname === "/api/v1/order") return json(200, { status: "Filled", executedQuantity: "0.24", executedQuoteQuantity: "48.1" });
      json(404, { message: "no such route" });
    });
  });
  await new Promise<void>((ok) => server.listen(BP_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => {
  install(); seed(); resetStocks(); hits = []; open = true; fills = [{ fillQuantity: "0.24", fillQuoteQuantity: "48.05" }];
  balances = { USDC: { available: "500", locked: "0" }, "AAPL.US": { available: "1.5", locked: "0" }, SOL: { available: "3", locked: "0" } };
  currentPolicy().investMaxUsd = 100;
});

test("a signed call is signed the way Backpack documents: the instruction, sorted fields, a timestamp and a window, ED25519", () => {
  const ts = 1_700_000_000_000;
  const sig = signature("rfqSubmit", { side: "Bid", symbol: "AAPL.US_USDC_RFQ", quantity: "1" }, ts, BP_SECRET);
  const key = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" }));
  assert.ok(verify(null, Buffer.from(`instruction=rfqSubmit&quantity=1&side=Bid&symbol=AAPL.US_USDC_RFQ&timestamp=${ts}&window=10000`), key, Buffer.from(sig, "base64")));
  assert.throws(() => signature("x", {}, ts, "c2hvcnQ="), /32-byte/);
});

test("the list joins Backpack's securities with their fair-market prices, and a chart reads the history", async () => {
  const l = await listStocks();
  assert.deepEqual(l.map((s) => [s.ticker, s.priceUsd, s.change24hPct]), [["AAPL", 200, 1.25], ["SPY", null, null]]);
  const c = await stockChart("AAPL.US", 30);
  assert.deepEqual([c.points.length, c.changePct, c.high, c.low], [2, (200 - 190) / 190 * 100, 200, 190]);
  await assert.rejects(stockChart("BTC", 30), /not a US stock/);
  await assert.rejects(stockChart("AAPL.US", 5), /Choose 7/);
});

test("the account is read from Backpack with its own key and signature, and shows only US shares", async () => {
  assert.equal(await depositAddress(), DEPOSIT);
  const a = await account();
  assert.deepEqual([a.usdc, a.positions], [500, [{ asset: "AAPL.US", quantity: 1.5 }]]);
  const h = hits.find((x) => x.url.startsWith("/api/v1/capital"))!;
  assert.deepEqual([h.headers["x-api-key"], typeof h.headers["x-signature"], h.headers["x-window"]], ["test-backpack-key", "string", "10000"]);
});

test("funding is an ordinary USDC payment on Base to the address Backpack gave, decided by the rules and the council", async () => {
  const p = await fundAccount({ amountUsd: 150 });
  assert.deepEqual([p.invoice.category, p.invoice.issuedBy, p.invoice.chain, p.invoice.asset, p.invoice.payoutAddress, p.invoice.amountUsd], ["investment", "backpack", "base", "USDC", DEPOSIT, 150]);
  assert.equal(p.checks.find((c) => c.id === "payout_changed")!.verdict, "allow");
  assert.ok(p.verified.pqSignature.valid);
  await assert.rejects(fundAccount({ amountUsd: 5 }), /from \$10/);
  assert.equal(state().payments.length, 1);
});

test("a buy in market hours is a request for quote with a price cap, limited by the council's cap, the account's cash and the order size", async () => {
  const r = await trade({ asset: "AAPL.US", side: "buy", amountUsd: 50 });
  assert.deepEqual([r.via, r.status, r.filledQty, r.capPrice, r.quantity], ["rfq", "Filled", 0.24, 202, 0.24]);
  const rfq = hits.find((h) => h.url === "/api/v1/rfq")!;
  assert.deepEqual([rfq.body.symbol, rfq.body.side, rfq.body.price, rfq.body.executionMode, rfq.body.quantity], ["AAPL.US_USDC_RFQ", "Bid", "202.00", "Immediate", "0.24"]);
  await assert.rejects(trade({ asset: "AAPL.US", side: "buy", amountUsd: 101 }), /allows up to \$100/);
  await assert.rejects(trade({ asset: "AAPL.US", side: "buy", amountUsd: 1 }), /smallest order/);
  await assert.rejects(trade({ asset: "SPY.US", side: "buy", amountUsd: 50 }), /no price/);
  await assert.rejects(trade({ asset: "NOPE.US", side: "buy", amountUsd: 50 }), /not a stock Backpack lists/);
  balances.USDC.available = "10";
  await assert.rejects(trade({ asset: "AAPL.US", side: "buy", amountUsd: 50 }), /Fund it first/);
  currentPolicy().investMaxUsd = 0;
  await assert.rejects(trade({ asset: "AAPL.US", side: "buy", amountUsd: 50 }), /has not allowed investing/);
});

test("a sell needs the shares, and outside market hours it uses the order book only where there is one", async () => {
  await assert.rejects(trade({ asset: "AAPL.US", side: "sell", amountUsd: 400 }), /allows up to|does not hold/);
  currentPolicy().investMaxUsd = 1000;
  await assert.rejects(trade({ asset: "AAPL.US", side: "sell", amountUsd: 600 }), /does not hold/);
  open = false; resetStocks();
  const r = await trade({ asset: "AAPL.US", side: "sell", amountUsd: 100 });
  assert.deepEqual([r.via, r.status, r.filledQty], ["spot", "Filled", 0.24]);
  const o = hits.find((h) => h.url === "/api/v1/order")!;
  assert.deepEqual([o.body.symbol, o.body.side, o.body.timeInForce, o.body.price], ["AAPL.US_USDC", "Ask", "IOC", "198.00"]);
  balances["SPY.US"] = { available: "5", locked: "0" };
  await assert.rejects(trade({ asset: "SPY.US", side: "sell", amountUsd: 100 }), /no price|no order book/);
});

test("the route needs a signed-in person, and trades through it come back with their result", async () => {
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const get = (q = "", signed = true) => stocksGet(new Request(`https://x.example/api/stocks${q}`, { headers: signed ? { cookie } : {} }), undefined) as Promise<Response>;
  assert.equal((await get("", false)).status, 400);
  const list = (await (await get()).json()) as { configured: boolean; stocks: unknown[] };
  assert.deepEqual([list.configured, list.stocks.length], [true, 2]);
  const post = (b: unknown) => stocksPost(new Request("https://x.example/api/stocks", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  const done = await post({ action: "trade", asset: "AAPL.US", side: "buy", amountUsd: 50 });
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { trade: { status: string } }).trade.status, "Filled");
  assert.equal((await post({ action: "trade", asset: "AAPL.US", side: "hold", amountUsd: 50 })).status, 400);
  assert.equal((await post({ action: "fund", amountUsd: 100 })).status, 200);
});
