import "./setup";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import { POST as checkRoute } from "../app/api/check/route";
import { POST as pollRoute } from "../app/api/agentmarket/poll/route";
import { parsePayee, pollAgentMarket } from "../lib/agentmarket";
import { lookupSignals } from "../lib/chain";
import { appCompose, checkMeasurements, expectedMrConfigId, replayRtmr3 } from "../lib/tdx";
import { install, seed } from "./fakes";

beforeEach(() => {
  install();
  seed();
});

/** Run a test body with fetch replaced by `handler`, recording every call. */
async function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, body: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = real;
  }
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// An independent implementation of the documented replay, to check lib/tdx against.
const sha384 = (b: Buffer) => createHash("sha384").update(b).digest();
function eventDigest(type: number, name: string, payloadHex: string) {
  const t = Buffer.alloc(4);
  t.writeUInt32LE(type);
  return sha384(Buffer.concat([t, Buffer.from(`:${name}:`), Buffer.from(payloadHex, "hex")]));
}

test("RTMR3 replay follows the documented extend rule, skips other registers, and rejects a bad digest", () => {
  const e1 = { imr: 3, event_type: 134217729, event: "app-id", event_payload: "aabbcc" };
  const e2 = { imr: 3, event_type: 134217729, event: "compose-hash", event_payload: "01ff" };
  const other = { imr: 2, event_type: 1, event: "ignored", event_payload: "00" };
  let r = Buffer.alloc(48);
  r = sha384(Buffer.concat([r, eventDigest(e1.event_type, e1.event, e1.event_payload)]));
  r = sha384(Buffer.concat([r, eventDigest(e2.event_type, e2.event, e2.event_payload)]));
  assert.equal(replayRtmr3([e1, other, e2]), r.toString("hex"));
  assert.equal(replayRtmr3(JSON.stringify([e1, other, e2])), r.toString("hex")); // the gateway returns it as a JSON string
  const withDigest = { ...e1, digest: eventDigest(e1.event_type, e1.event, e1.event_payload).toString("hex") };
  assert.doesNotThrow(() => replayRtmr3([withDigest]));
  assert.throws(() => replayRtmr3([{ ...e1, digest: "00".repeat(48) }]), /digest does not match/);
});

test("MRCONFIGID binds the raw app_compose: 0x01, sha256, 15 zero bytes", () => {
  const compose = '{"name":"x"}';
  const expected = "01" + createHash("sha256").update(compose).digest("hex") + "00".repeat(15);
  assert.equal(expectedMrConfigId(compose), expected);
  assert.equal(expected.length, 96);
  assert.equal(appCompose({ tcb_info: JSON.stringify({ app_compose: compose }) }), compose);
  assert.equal(appCompose({ tcb_info: { app_compose: compose } }), compose);

  const ev = { imr: 3, event_type: 1, event: "e", event_payload: "" };
  const rtMr3 = sha384(Buffer.concat([Buffer.alloc(48), eventDigest(1, "e", "")]));
  const quote = { rtMr3, mrConfigId: Buffer.from(expected, "hex") };
  assert.deepEqual(checkMeasurements({ event_log: [ev], info: { tcb_info: { app_compose: compose } } }, quote), { ok: true, problems: [] });
  const bad = checkMeasurements({ event_log: [ev], info: { tcb_info: { app_compose: compose + " " } } }, quote);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /MRCONFIGID/);
  assert.equal(checkMeasurements({ info: {} }, quote).ok, false);
});

test("x402: no header gives a spec-shaped 402; verify then settle with the spec body; unsettled payment is refused", async () => {
  const call = (headers: Record<string, string> = {}) =>
    checkRoute(new Request("https://proofpay.example/api/check", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ payoutAddress: "0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912" }) }), undefined);
  const r402 = await call();
  assert.equal(r402.status, 402);
  const j = await r402.json();
  assert.equal(j.x402Version, 1);
  assert.equal(j.error, "X-PAYMENT header is required");
  assert.equal(j.accepts[0].maxTimeoutSeconds, 60);
  assert.equal(j.accepts[0].payTo, "treasury.near");

  const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "near", payload: { signature: "s" } })).toString("base64");
  await withFetch(
    (url) => (url.endsWith("/verify") ? json({ isValid: true, payer: "p" }) : json({ success: true, transaction: "tx", network: "near" })),
    async (calls) => {
      const ok = await call({ "x-payment": payment });
      assert.equal(ok.status, 200);
      assert.ok(["allow", "warn", "block"].includes((await ok.json()).verdict));
      const verify = calls.find((c) => c.url.endsWith("/verify"))!;
      const sent = JSON.parse(String(verify.init?.body));
      assert.equal(sent.x402Version, 1);
      assert.equal(sent.paymentPayload.scheme, "exact");
      assert.equal(sent.paymentRequirements.asset.length, 64);
      assert.ok(calls.some((c) => c.url.endsWith("/settle")));
    }
  );
  await withFetch(
    (url) => (url.endsWith("/verify") ? json({ isValid: true }) : json({ success: false, errorReason: "insufficient_funds" })),
    async () => assert.equal((await call({ "x-payment": payment })).status, 402)
  );
  await withFetch(() => json({ isValid: false, invalidReason: "bad_signature" }), async () => {
    const bad = await call({ "x-payment": payment });
    assert.equal(bad.status, 402);
    assert.match((await bad.json()).error, /bad_signature/);
  });
  assert.equal((await call({ "x-payment": "not base64 json !!" })).status, 402);
});

test("Agent Market: finds the payee, starts, submits a verdict; asks when there is no payee", async () => {
  assert.equal(parsePayee("please check 0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912 thanks")?.chain, "eth");
  assert.equal(parsePayee('{"payoutAddress":"acme.near","vendorName":"Acme"}')?.vendorName, "Acme");
  assert.equal(parsePayee("no address here"), null);

  const item = (id: string, description: string) => ({ assignment: { assignmentId: id, startedAt: null }, job: { title: "t", description }, latestMessage: null });
  await withFetch(
    (url, init) => {
      if (url.includes("/assignments?")) return json({ assignments: [item("a1", "check 0x9f3b2c1d7e0a45b6c8d9e1f2a3b4c5d6e7f80912"), item("a2", "check my supplier")] });
      return json({ ok: true }, init?.method === "POST" && url.endsWith("/messages") ? 201 : 200);
    },
    async (calls) => {
      const out = await pollAgentMarket();
      assert.deepEqual(out.map((o) => [o.assignmentId, o.action]), [["a1", "submitted"], ["a2", "asked"]]);
      const submit = calls.find((c) => c.url.endsWith("/a1/submit"))!;
      assert.match(JSON.parse(String(submit.init?.body)).deliverableMarkdown, /Proofpay Check:/);
      assert.equal((submit.init?.headers as Record<string, string>).authorization, "Bearer aat_test");
      assert.ok(calls.some((c) => c.url.endsWith("/a1/start")) && calls.some((c) => c.url.endsWith("/a2/messages")));
      assert.ok(!calls.some((c) => c.url.endsWith("/a2/submit")));
      assert.equal(JSON.parse(String(calls.find((c) => c.url.endsWith("/a2/messages"))!.init?.body)).clientRequestId, "ask-a2");
    }
  );
});

test("Agent Market poll route needs a signer or the cron secret", async () => {
  const post = (headers: Record<string, string> = {}) => pollRoute(new Request("https://proofpay.example/api/agentmarket/poll", { method: "POST", headers }), undefined);
  assert.equal((await post()).status, 400);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 400);
  await withFetch(() => json({ assignments: [] }), async () => assert.equal((await post({ authorization: "Bearer cron-secret-test" })).status, 200));
});

test("NEAR payee age comes from NearBlocks created.block_timestamp (ns); a missing account is brand new", async () => {
  const tenDaysAgoNs = String((Date.now() - 10 * 86_400_000) * 1_000_000);
  await withFetch(
    (url) => {
      if (url.includes("nearblocks")) return json({ data: { account_id: "x", created: { block_timestamp: tenDaysAgoNs } } });
      return json({ jsonrpc: "2.0", result: { code_hash: "11111111111111111111111111111111", amount: "1" } });
    },
    async () => {
      const s = await lookupSignals("aged-account.near", "near");
      assert.equal(s?.ageDays, 10);
      assert.equal(s?.isContract, false);
    }
  );
  await withFetch(
    () => json({ jsonrpc: "2.0", error: { cause: { name: "UNKNOWN_ACCOUNT" } } }),
    async () => assert.equal((await lookupSignals("ghost-account-xyz.near", "near"))?.ageDays, 0)
  );
});
