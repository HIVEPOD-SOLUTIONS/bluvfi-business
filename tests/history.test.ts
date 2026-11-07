import "./setup";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { GET as historyRoute } from "../app/api/history/route";
import { POST as fundRoute } from "../app/api/fund/route";
import { processInvoice } from "../lib/agent";
import { filterHistory, historyCsv, historyEntries } from "../lib/history";
import { issueSession } from "../lib/session";
import { install, invoice, seed, state } from "./fakes";

beforeEach(() => { install(); seed(); });

const cookie = async () => `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
const call = async (fn: (r: Request, c: unknown) => Promise<Response> | Response, url: string, body?: unknown, signedIn = true) =>
  fn(new Request(`https://x.example${url}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(signedIn ? { cookie: await cookie() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), undefined);

test("history gathers every kind of money movement, newest first, in plain words", async () => {
  const s = state();
  await processInvoice(invoice({ invoiceNumber: "INV-H1" }));
  await processInvoice(invoice({ invoiceNumber: "INV-H2", category: "bill", vendorName: "Northwind Cloud Ltd" }));
  s.receivables.push({ id: "rcv-1", client: "Beta Corp", description: "Consulting", amountUsd: 500, asset: "USDC", chain: "near", payTo: "treasury.near", createdAt: "2026-01-02T00:00:00.000Z", status: "paid", settlement: { status: "SUCCESS", checkedAt: "2026-01-03T00:00:00.000Z", note: "" } });
  s.receivables.push({ id: "rcv-2", client: "Treasury funding", description: "Money put into the treasury", amountUsd: 250, asset: "USDC", chain: "near", payTo: "treasury.near", createdAt: "2026-01-04T00:00:00.000Z", kind: "funding", status: "open" });
  s.x402Spend.push({ at: "2026-01-05T00:00:00.000Z", url: "https://api.example.com/v1/data", priceUsd: 0.01 });
  s.cardPurchases = [{ id: "card-1", merchant: "Office Supplies Co", amountUsd: 40, reason: "Printer paper", note: "", requestedBy: "maya", createdAt: "2026-01-06T00:00:00.000Z", status: "issued", approvals: [], authorizations: [] }];

  const all = historyEntries();
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((e) => e.at), [...all.map((e) => e.at)].sort().reverse(), "newest first");
  const by = (id: string) => all.find((e) => e.id === id)!;
  assert.deepEqual([by("rcv-1").category, by("rcv-1").direction, by("rcv-1").status, by("rcv-1").tone, by("rcv-1").at], ["received", "in", "Received", "ok", "2026-01-03T00:00:00.000Z"]);
  assert.deepEqual([by("rcv-2").category, by("rcv-2").status, by("rcv-2").tone], ["funding", "Waiting for the deposit", "warn"]);
  assert.deepEqual([all.find((e) => e.category === "api")!.title, all.find((e) => e.category === "api")!.direction], ["api.example.com", "out"]);
  assert.deepEqual([by("card-1").category, by("card-1").status], ["card", "Card issued"]);
  assert.ok(all.some((e) => e.category === "bill"), "a bill is labelled as one");
  assert.ok(all.some((e) => e.category === "payment" && e.href?.startsWith("/payments/")));
});

test("filters narrow it by what, text, dates and tone, and the last day of a range counts whole", () => {
  const s = state();
  s.receivables.push({ id: "r1", client: "Alpha", description: "A", amountUsd: 10, asset: "USDC", chain: "near", payTo: "t", createdAt: "2026-02-01T10:00:00.000Z", status: "open" });
  s.receivables.push({ id: "r2", client: "Beta", description: "B", amountUsd: 20, asset: "USDC", chain: "near", payTo: "t", createdAt: "2026-02-10T23:30:00.000Z", status: "open" });
  const all = historyEntries();
  assert.equal(filterHistory(all, { q: "alp" }).length, 1);
  assert.equal(filterHistory(all, { category: "received" }).length, 2);
  assert.equal(filterHistory(all, { category: "bill" }).length, 0);
  assert.deepEqual(filterHistory(all, { from: "2026-02-05" }).map((e) => e.id), ["r2"]);
  assert.deepEqual(filterHistory(all, { to: "2026-02-10" }).map((e) => e.id).sort(), ["r1", "r2"], "the whole of the last day");
  assert.equal(filterHistory(all, { to: "2026-02-09" }).length, 1);
  assert.equal(filterHistory(all, { status: "warn" }).length, 2);
});

test("the CSV neutralises spreadsheet formulas and quotes awkward text", () => {
  state().receivables.push({ id: "r1", client: '=HYPERLINK("http://evil.example","click")', description: 'Says "hello", then more', amountUsd: 12.5, asset: "USDC", chain: "near", payTo: "t", createdAt: "2026-03-01T00:00:00.000Z", status: "open" });
  const csv = historyCsv(historyEntries());
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "When,Category,Title,Detail,Direction,Amount (USD),Status,Transaction");
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), "a leading = is made harmless");
  assert.ok(lines[1].includes('"Says ""hello"", then more"'));
  assert.ok(lines[1].includes(",12.50,"));
});

test("the history route needs a signed-in signer, returns JSON, and a CSV file with the same filters", async () => {
  state().receivables.push({ id: "r1", client: "Alpha", description: "A", amountUsd: 10, asset: "USDC", chain: "near", payTo: "t", createdAt: "2026-04-01T00:00:00.000Z", status: "open" });
  assert.equal((await call(historyRoute as never, "/api/history", undefined, false)).status, 400, "not signed in");
  const json = (await (await call(historyRoute as never, "/api/history?q=alpha")).json()) as { entries: { id: string }[] };
  assert.deepEqual(json.entries.map((e) => e.id), ["r1"]);
  const csv = await call(historyRoute as never, "/api/history?format=csv&q=zzz");
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(csv.headers.get("content-disposition") ?? "", /bluvfi-history\.csv/);
  assert.equal((await csv.text()).trim().split("\n").length, 1, "filtered to nothing: only the header");
});

test("funding: a funding link to the business's own treasury is made, checked, and shows up in history", async () => {
  assert.equal((await call(fundRoute as never, "/api/fund", { amountUsd: 100 }, false)).status, 400, "not signed in");
  for (const bad of [0, 0.5, -5, 2_000_000, "abc"]) assert.equal((await call(fundRoute as never, "/api/fund", { amountUsd: bad })).status, 400, `rejects ${bad}`);
  const res = await call(fundRoute as never, "/api/fund", { amountUsd: 250.456 });
  assert.equal(res.status, 200);
  const { receivable } = (await res.json()) as { receivable: { id: string; amountUsd: number; payTo: string; kind: string; chain: string } };
  assert.deepEqual([receivable.amountUsd, receivable.payTo, receivable.kind, receivable.chain], [250.46, "treasury.near", "funding", "near"]);
  assert.equal(state().receivables[0].id, receivable.id);
  assert.ok(historyEntries().some((e) => e.id === receivable.id && e.category === "funding" && e.direction === "in"));
});
