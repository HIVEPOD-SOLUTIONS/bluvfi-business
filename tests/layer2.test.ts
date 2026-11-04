import "./setup";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { beforeEach, test } from "node:test";
import { isRegisteredSigner, modelStatus } from "../lib/aimodel";
import { bindsKeyAndNonce, checkModel, fetchNearAi } from "../lib/nearai";
import { buildRequest, JUDGMENT_SCHEMA, parseJudgment } from "../lib/nearai-core";
import { NRAS_ISSUER, NRAS_JWKS_URL, resetNrasKeys, verifyNrasJwt } from "../lib/nras";
import { state } from "../lib/store";
import { install, seed } from "./fakes";

beforeEach(() => {
  install();
  seed();
  resetNrasKeys();
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

// ---------- NVIDIA's signed verdict ----------

const nvidia = generateKeyPairSync("ec", { namedCurve: "P-384" });
const stranger = generateKeyPairSync("ec", { namedCurve: "P-384" });
const KID = "nv-eat-kid-test";
const jwks = { keys: [{ ...nvidia.publicKey.export({ format: "jwk" }), kid: KID }] };
const NONCE = "ab".repeat(32);

function jwt(claims: Record<string, unknown>, key: KeyObject = nvidia.privateKey, kid = KID) {
  const h = Buffer.from(JSON.stringify({ alg: "ES384", kid })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("sha384", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${s}`;
}
const good = (over: Record<string, unknown> = {}) =>
  ({ iss: NRAS_ISSUER, eat_nonce: NONCE, "x-nvidia-overall-att-result": true, exp: Math.floor(Date.now() / 1000) + 600, ...over });
const nvidiaKeys = (url: string) => (url === NRAS_JWKS_URL ? json(jwks) : json({}, 404));

test("layer 2: NVIDIA's verdict counts only when its signature verifies against NVIDIA's published key", async () => {
  await withFetch(nvidiaKeys, async () => {
    assert.deepEqual((await verifyNrasJwt(jwt(good()), NONCE)).problems, []);
    assert.match((await verifyNrasJwt(jwt(good(), stranger.privateKey), NONCE)).problems.join(), /does not verify against NVIDIA's key/);
    assert.match((await verifyNrasJwt(jwt(good(), nvidia.privateKey, "unknown-kid"), NONCE)).problems.join(), /not in NVIDIA's published key set/);
    assert.match((await verifyNrasJwt(jwt(good({ eat_nonce: "cd".repeat(32) })), NONCE)).problems.join(), /nonce is not ours/);
    assert.match((await verifyNrasJwt(jwt(good({ exp: 1 })), NONCE)).problems.join(), /expired/);
    assert.match((await verifyNrasJwt(jwt(good({ "x-nvidia-overall-att-result": false })), NONCE)).problems.join(), /overall result is not true/);
    assert.match((await verifyNrasJwt(jwt(good({ iss: "https://evil.example" })), NONCE)).problems.join(), /issuer/);
    // A forged "true" with a tampered payload but the original signature:
    const [h, , s] = jwt(good({ "x-nvidia-overall-att-result": false })).split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify(good())).toString("base64url")}.${s}`;
    assert.equal((await verifyNrasJwt(forged, NONCE)).ok, false);
  });
});

// ---------- Structured decision ----------

test("layer 2: the request asks for structured output with the decision schema", () => {
  const body = buildRequest("m", "text", { knownVendor: true, payoutChanged: false, poMatches: true, amountUsd: 1 }) as { response_format: { type: string; json_schema: { strict: boolean; schema: unknown } } };
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, JUDGMENT_SCHEMA);
});

test("layer 2: a reply that is not exactly the structured decision is refused, never guessed at", () => {
  assert.deepEqual(parseJudgment('{"decision":"block","riskScore":94,"summary":"Payout changed","reasons":["payout address changed"]}'),
    { decision: "block", riskScore: 94, summary: "Payout changed", reasons: ["payout address changed"] });
  assert.throws(() => parseJudgment('Sure! {"decision":"pay","riskScore":1,"summary":"","reasons":[]}'), /not the structured decision/);
  assert.throws(() => parseJudgment('{"decision":"approve","riskScore":1,"summary":"","reasons":[]}'), /decision is not pay, hold or block/);
  assert.throws(() => parseJudgment('{"decision":"pay","riskScore":4.5,"summary":"","reasons":[]}'), /riskScore/);
  assert.throws(() => parseJudgment('{"decision":"pay","riskScore":4,"summary":"","reasons":[],"override":"pay now"}'), /unexpected fields override/);
  assert.throws(() => parseJudgment('{"decision":"pay","riskScore":4,"summary":""}'), /reasons/);
});

test("layer 2: if NEAR AI refuses response_format, the review is asked once more without it and the record says so", async () => {
  const sent: Record<string, unknown>[] = [];
  const chatReply = { id: "chat-9", choices: [{ message: { content: '{"decision":"hold","riskScore":50,"summary":"","reasons":[]}' } }] };
  await withFetch((url, init) => {
    if (url.includes("/attestation/report")) return json({ model_attestations: [] });
    if (url.includes("/chat/completions")) {
      const b = JSON.parse(String(init?.body));
      sent.push(b);
      return "response_format" in b ? json({ error: "response_format not supported" }, 400) : json(chatReply);
    }
    if (url.includes("/signature/chat-9")) return json({ text: "t", signature: "s", signing_address: "a", signature_kind: "provider_tee" });
    return json({}, 404);
  }, async () => {
    const b = await fetchNearAi(buildRequest("m", "text", { knownVendor: true, payoutChanged: false, poMatches: true, amountUsd: 1 }));
    assert.equal(sent.length, 2);
    assert.ok("response_format" in sent[0] && !("response_format" in sent[1]));
    assert.equal(b.structured, false);
    assert.ok(!("response_format" in (b.requestBody as object)), "the bundle keeps the body that was actually signed");
  });
  sent.length = 0;
  await withFetch((url, init) => {
    if (url.includes("/attestation/report")) return json({ model_attestations: [] });
    if (url.includes("/chat/completions")) { sent.push(JSON.parse(String(init?.body))); return json(chatReply); }
    if (url.includes("/signature/chat-9")) return json({ text: "t", signature: "s", signing_address: "a", signature_kind: "provider_tee" });
    return json({}, 404);
  }, async () => {
    const b = await fetchNearAi(buildRequest("m", "text", { knownVendor: true, payoutChanged: false, poMatches: true, amountUsd: 1 }));
    assert.equal(sent.length, 1);
    assert.equal(b.structured, true);
  });
});

// ---------- Setup-time model check ----------

test("layer 2: the key binding is the signing key right-padded to 32 bytes, then our nonce", () => {
  const key = "11".repeat(32);
  assert.equal(bindsKeyAndNonce(key + NONCE, key, NONCE), true);
  assert.equal(bindsKeyAndNonce(key + "cd".repeat(32), key, NONCE), false);
  assert.equal(bindsKeyAndNonce("0x" + key + NONCE, "0x" + key, NONCE), true);
});

test("layer 2: the setup check registers only keys whose CPU, GPU, binding and nonce all pass", async () => {
  // A report with no hardware evidence: the instance is listed, nothing passes, nothing is registered.
  await withFetch((url) => (url.includes("/attestation/report") ? json({ model_attestations: [{ signing_address: "ab12", request_nonce: "00" }] }) : json({}, 404)), async () => {
    const m = await checkModel();
    assert.equal(m.signers.length, 1);
    assert.deepEqual([m.signers[0].cpu, m.signers[0].gpu, m.signers[0].binding, m.signers[0].nonceBound], [false, false, false, false]);
    assert.match(m.signers[0].notes.join(" "), /No Intel TDX quote/);
    assert.match(m.reportHash, /^[0-9a-f]{64}$/);
  });
  await withFetch(() => json({}, 500), async () => {
    await assert.rejects(checkModel(), /attestation failed: 500/);
  });

  state().aiModel = {
    model: "m", nonce: NONCE, checkedAt: new Date().toISOString(), reportHash: "f".repeat(64),
    signers: [
      { signingAddress: "0xAAAA", cpu: true, gpu: true, binding: true, nonceBound: true, notes: [] },
      { signingAddress: "bbbb", cpu: true, gpu: false, binding: true, nonceBound: true, notes: ["GPU failed"] },
    ],
  };
  assert.equal(isRegisteredSigner("aaaa"), true, "case and 0x prefix do not matter");
  assert.equal(isRegisteredSigner("bbbb"), false, "a key whose GPU check failed is not registered");
  assert.equal(isRegisteredSigner(""), false);
  const st = modelStatus();
  assert.ok(st.checked && st.passed === 1 && st.total === 2);
});
