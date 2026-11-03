import { OUTSIDE_PORT } from "./setup-channels";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { POST as channels, GET as channelsGet } from "../app/api/channels/route";
import { POST as poll } from "../app/api/agentmarket/poll/route";
import { POST as paidCheck } from "../app/api/check/route";
import { POST as freeCheck } from "../app/api/check/try/route";
import { POST as setup } from "../app/api/setup/route";
import { POST as telegram } from "../app/api/telegram/webhook/route";
import { POST as voice } from "../app/api/twilio/voice/route";
import { processInvoice } from "../lib/agent";
import { businesses, cfg, createBusiness, resetRegistry, setChannels, setTreasury, type Business } from "../lib/business";
import { COOKIE, issueSession, privySubject } from "../lib/session";
import { resetAllState, state } from "../lib/store";
import { addMember } from "../lib/team";
import { runAs } from "../lib/tenant";
import { install, invoice, seed } from "./fakes";

const PUBLIC = "https://bluvfi-business.example";
const calls: { path: string; body: unknown; auth?: string }[] = [];
let server: Server;

before(async () => {
  server = createServer((incoming, res) => {
    let raw = "";
    incoming.on("data", (c) => (raw += c));
    incoming.on("end", () => {
      const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      calls.push({ path: incoming.url ?? "", body: raw ? JSON.parse(raw) : undefined, auth: incoming.headers.authorization });
      if (incoming.url?.startsWith("/telegram/bot999999:")) return send({ ok: false, description: "Unauthorized" });
      if (incoming.url?.startsWith("/telegram/")) return send({ ok: true });
      if (incoming.url?.startsWith("/market/")) return send({ assignments: [] });
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(OUTSIDE_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { resetAllState(); resetRegistry(); calls.length = 0; install(); });

let n = 0;
const req = (url: string, body: unknown, over: { cookie?: string; headers?: Record<string, string>; form?: boolean; method?: string } = {}) =>
  new Request(`http://app.test${url}`, {
    method: over.method ?? "POST",
    headers: { ...(over.form ? {} : { "content-type": "application/json" }), "x-forwarded-for": `10.1.${Math.floor(++n / 250)}.${n % 250}`, ...(over.cookie ? { cookie: `${COOKIE}=${over.cookie}` } : {}), ...(over.headers ?? {}) },
    body: over.method === "GET" ? undefined : over.form ? (body as URLSearchParams) : JSON.stringify(body),
  });

const as = async (b: Business, email: string) => encodeURIComponent((await issueSession(privySubject(b.id, email)))!);
const TG_A = "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TG_B = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function connectTelegram(b: Business, email: string, token: string) {
  const res = await channels(req("/api/channels", { telegramBotToken: token }, { cookie: await as(b, email) }), undefined);
  assert.equal(res.status, 200);
  return res;
}

test("an owner connects their own Telegram bot: it is registered for their business only, and stored encrypted", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const res = await connectTelegram(a, "ada@acme.test", TG_A);
  const hook = calls.find((c) => c.path === `/telegram/bot${TG_A}/setWebhook`)!;
  const body = hook.body as { url: string; secret_token: string };
  assert.equal(body.url, `${PUBLIC}/api/telegram/webhook?b=${a.id}`);
  assert.match(body.secret_token, /^[0-9a-f]{48}$/);
  assert.equal(((await res.json()) as { channels: { telegram: boolean } }).channels.telegram, true);
  assert.equal(runAs(a.id, () => cfg().TELEGRAM_BOT_TOKEN), TG_A);
  assert.equal(runAs(a.id, () => cfg().TELEGRAM_WEBHOOK_SECRET), body.secret_token);
  const saved = JSON.stringify(businesses());
  assert.ok(!saved.includes(TG_A) && !saved.includes(body.secret_token), "secrets must be encrypted at rest");
  // Another business has nothing of it.
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  assert.equal(runAs(b.id, () => cfg().TELEGRAM_BOT_TOKEN), "");
  // The status never returns a secret.
  const got = await channelsGet(req("/api/channels", undefined, { cookie: await as(a, "ada@acme.test"), method: "GET" }), undefined);
  assert.ok(!JSON.stringify(await got.json()).includes(TG_A));
});

test("channel settings are owner-only and validated, and a bot Telegram rejects is not saved", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  runAs(a.id, () => addMember("ada@acme.test", "cara@acme.test"));
  const no = await channels(req("/api/channels", { telegramBotToken: TG_A }, { cookie: await as(a, "cara@acme.test") }), undefined);
  assert.match(((await no.json()) as { error: string }).error, /Only an owner/);
  const bad = await channels(req("/api/channels", { twilioFrom: "555" }, { cookie: await as(a, "ada@acme.test") }), undefined);
  assert.match(((await bad.json()) as { error: string }).error, /international format/);
  const rejected = await channels(req("/api/channels", { telegramBotToken: "999999:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }, { cookie: await as(a, "ada@acme.test") }), undefined);
  assert.match(((await rejected.json()) as { error: string }).error, /Telegram did not accept that bot: Unauthorized/);
  assert.equal(runAs(a.id, () => cfg().TELEGRAM_BOT_TOKEN), "");
});

test("a vendor reply on Telegram reaches only the business whose bot it came through", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  await connectTelegram(a, "ada@acme.test", TG_A);
  await connectTelegram(b, "bob@bolt.test", TG_B);
  const secretA = runAs(a.id, () => cfg().TELEGRAM_WEBHOOK_SECRET);
  // Both businesses have a pending callback to the same chat id (the same person is a vendor of both).
  const pending = (biz: string) =>
    runAs(biz, async () => {
      seed();
      return (await processInvoice(invoice({ invoiceNumber: "INV-7", chain: "eth", payoutAddress: "0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912" }))).id;
    });
  const [pa, pb] = [await pending(a.id), await pending(b.id)];
  const reply = (biz: string, secret: string | null) =>
    telegram(req(`/api/telegram/webhook${biz ? `?b=${biz}` : ""}`, { message: { chat: { id: 555111 }, text: "NO INV-7" } }, { headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} }));
  const status = (biz: string, id: string) => runAs(biz, () => state().payments.find((p) => p.id === id)!.callback?.status);

  // A's secret does not open B's webhook, nor the operator's, and an unknown business gets nothing.
  assert.equal((await reply(b.id, secretA)).status, 403);
  assert.equal((await reply("", secretA)).status, 403);
  assert.equal((await reply("bz_0000000000", secretA)).status, 403);
  assert.equal((await reply(a.id, null)).status, 403);
  assert.equal(status(b.id, pb), "pending");

  assert.equal((await reply(a.id, secretA)).status, 200);
  assert.equal(status(a.id, pa), "denied");
  assert.equal(status(b.id, pb), "pending");
  // The answer went out through A's own bot.
  assert.ok(calls.some((c) => c.path === `/telegram/bot${TG_A}/sendMessage`));
  assert.ok(!calls.some((c) => c.path === `/telegram/bot${TG_B}/sendMessage`));
});

test("a voice reply counts only if it is signed with that business's own Twilio token and names that business", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  const tokA = "a".repeat(32);
  const tokB = "b".repeat(32);
  setChannels(a.id, { twilioSid: `AC${"1".repeat(32)}`, twilioToken: tokA, twilioFrom: "+15550000001" });
  setChannels(b.id, { twilioSid: `AC${"2".repeat(32)}`, twilioToken: tokB, twilioFrom: "+15550000002" });
  const pid = await runAs(a.id, async () => {
    seed();
    state().vendors[0].verifiedContact = { channel: "voice", handle: "+15557654321" };
    return (await processInvoice(invoice({ invoiceNumber: "INV-9", chain: "eth", payoutAddress: "0x1111111111111111111111111111111111111111" }))).id;
  });
  const call = (token: string, biz: string) => {
    const path = `/api/twilio/voice?pid=${pid}&b=${biz}`;
    const sig = createHmac("sha1", token).update(`${PUBLIC}${path}Digits2`).digest("base64");
    return voice(req(path, new URLSearchParams({ Digits: "2" }), { form: true, headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" } }));
  };
  const status = () => runAs(a.id, () => state().payments.find((p) => p.id === pid)!.callback?.status);
  assert.equal((await call(tokB, a.id)).status, 403); // Bolt's token cannot answer for Acme
  assert.equal(status(), "pending");
  assert.equal((await call(tokA, b.id)).status, 403); // and Acme's token does not open Bolt's
  assert.equal((await call(tokA, a.id)).status, 200);
  assert.equal(status(), "denied");
});

test("Agent Market polling uses the business's own worker token and cron secret", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  setChannels(a.id, { agentMarketToken: "aat_acme_token_1234" });
  setChannels(b.id, { agentMarketToken: "aat_bolt_token_5678" });
  const [cronA, cronB] = [runAs(a.id, () => cfg().AGENT_MARKET_CRON_SECRET), runAs(b.id, () => cfg().AGENT_MARKET_CRON_SECRET)];
  assert.notEqual(cronA, cronB);
  const poke = (biz: string, bearer?: string) => poll(req(`/api/agentmarket/poll?b=${biz}`, {}, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }), undefined);
  assert.equal((await poke(a.id, cronA)).status, 200);
  assert.equal(calls.find((c) => c.path.startsWith("/market/"))!.auth, "Bearer aat_acme_token_1234");
  assert.equal((await poke(a.id, cronB)).status, 400); // Bolt's secret does not poll for Acme
  assert.equal((await poke(a.id)).status, 400);
  assert.equal((await poke(a.id, "x".repeat(48))).status, 400);
});

test("each business sells Check on its own terms and is paid to its own treasury", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  setTreasury(a.id, { custody: "manual", treasury: "acme.near" });
  setChannels(a.id, { x402FacilitatorUrl: "https://facilitator.acme.test" });
  const ask = (path: string) => paidCheck(req(path, { payoutAddress: "x.near" }), undefined);
  const payTo = async (res: Response) => ((await res.json()) as { accepts: { payTo: string }[] }).accepts[0].payTo;
  const resA = await ask(`/api/check?b=${a.id}`);
  assert.equal(resA.status, 402);
  assert.equal(await payTo(resA), "acme.near");
  assert.equal((await ask(`/api/check?b=${b.id}`)).status, 503); // Bolt has set nothing up
  assert.equal(await payTo(await ask("/api/check")), "treasury.near"); // the operator's own
  assert.equal((await ask("/api/check?b=bz_ffffffffff")).status, 400);

  // The free tier writes to the log of the business that was asked, and no other.
  const free = await freeCheck(req(`/api/check/try?b=${a.id}`, { payoutAddress: "0x1111111111111111111111111111111111111111" }), undefined);
  assert.equal(free.status, 200);
  assert.equal(runAs(a.id, () => state().checkLog.length), 1);
  assert.equal(runAs(b.id, () => state().checkLog.length), 0);
  assert.equal(state().checkLog.length, 0);
});

test("only a business's owner can set up its treasury, and without a session there is no way in", async () => {
  const a = createBusiness("Acme Ltd", "ada@acme.test");
  runAs(a.id, () => addMember("ada@acme.test", "cara@acme.test"));
  const check = (cookie?: string) => setup(req("/api/setup", { action: "check" }, { cookie }), undefined);
  assert.equal((await check(await as(a, "ada@acme.test"))).status, 200);
  assert.match(((await (await check(await as(a, "cara@acme.test"))).json()) as { error: string }).error, /Only an owner/);
  assert.match(((await (await check()).json()) as { error: string }).error, /Wrong setup code/);
});
