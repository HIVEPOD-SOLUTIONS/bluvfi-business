import "./setup";
import { WEBHOOK_KEY as KEY } from "./setup-passport-sdk";
import { createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { selfApi } from "../lib/passport";

const sign = (id: string, ts: string, body: string, key = KEY) => `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
const body = JSON.stringify({
  type: "verification.completed", verification_id: "ver_1", external_uuid: "6f1c2a3b-0000-4000-8000-000000000003", flow_id: "f", flow_version_id: "fv",
  environment: "live", status: "valid", proof_attributes: { minimumAge: 18, ofac: true }, proof: { pi_a: ["1"] }, nullifier: "n1",
  verified_at: "2026-11-06T10:00:00.000Z", storage_state: "skipped", storage_uri: null,
});

test("passport: Self's real SDK accepts a correctly signed webhook and rejects a forged or replayed one", async () => {
  const id = "msg_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const event = await selfApi.verifyWebhook(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sign(id, ts, body) });
  assert.equal(event.type, "verification.completed");
  assert.equal((event as { nullifier: string }).nullifier, "n1");

  await assert.rejects(selfApi.verifyWebhook(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sign(id, ts, body, randomBytes(24)) }), "signed with another key");
  await assert.rejects(selfApi.verifyWebhook(body.replace('"valid"', '"invalid"'), { "svix-id": id, "svix-timestamp": ts, "svix-signature": sign(id, ts, body) }), "body changed after signing");
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  await assert.rejects(selfApi.verifyWebhook(body, { "svix-id": id, "svix-timestamp": old, "svix-signature": sign(id, old, body) }), "an hour old: replay");
});
