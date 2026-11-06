import { PERSONA_PORT, WEBHOOK_SECRET } from "./setup-kyb";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { POST as kybRoute } from "../app/api/kyb/route";
import { POST as webhookRoute } from "../app/api/kyb/webhook/route";
import { processInvoice } from "../lib/agent";
import { createBusiness, getBusiness, resetRegistry } from "../lib/business";
import { handlePersonaWebhook, mapStatus, redactDue, refreshInquiry, resetKybIndex, startBusinessVerification, startVendorVerification, verifyPersonaSignature } from "../lib/kyb";
import { issueSession } from "../lib/session";
import { runAs } from "../lib/tenant";
import { makePolicy } from "../lib/policy";
import { currentPolicy } from "../lib/store";
import { install, invoice, seed, state } from "./fakes";

// Persona's API, as a local server: inquiries with a status we can set, the one-time link (sometimes only from the second endpoint).
interface Call { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
let calls: Call[] = [];
let inquiries: Record<string, string> = {};
let linkInCreate = true;
let n = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== "Bearer persona_sandbox_key_test") return send(401, { errors: [{ title: "Unauthorized" }] });
      if (req.method === "POST" && req.url === "/api/v1/inquiries") {
        const id = `inq_${++n}`;
        inquiries[id] = "created";
        return send(201, { data: { id, type: "inquiry", attributes: { status: "created" } }, meta: { "one-time-link": linkInCreate ? `https://persona.example/verify?code=${id}` : null } });
      }
      const gen = /^\/api\/v1\/inquiries\/(inq_\d+)\/generate-one-time-link$/.exec(req.url!);
      if (req.method === "POST" && gen) return send(200, { meta: { "one-time-link": `https://persona.example/verify?code=${gen[1]}&second=1` } });
      const get = /^\/api\/v1\/inquiries\/(inq_\d+)$/.exec(req.url!);
      if (req.method === "DELETE" && get) return inquiries[get[1]] ? send(200, { data: { id: get[1], type: "inquiry", attributes: { status: inquiries[get[1]], "redacted-at": new Date().toISOString() } } }) : send(404, { errors: [{ title: "Not found" }] });
      if (req.method === "GET" && get) return inquiries[get[1]] ? send(200, { data: { id: get[1], type: "inquiry", attributes: { status: inquiries[get[1]] } } }) : send(404, { errors: [{ title: "Not found" }] });
      send(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(PERSONA_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { calls = []; inquiries = {}; linkInCreate = true; n = 0; install(); seed(); resetKybIndex(); resetRegistry(); });

const sign = (body: string, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const event = (id: string, name = "inquiry.approved") => JSON.stringify({ data: { type: "event", attributes: { name, payload: { data: { type: "inquiry", id } } } } });

test("starting a vendor verification asks Persona for an inquiry on the vendor template with our key, and returns the link to send", async () => {
  const r = await startVendorVerification("Northwind Cloud Ltd");
  assert.equal(r.link, "https://persona.example/verify?code=inq_1");
  assert.deepEqual([r.kyb.status, r.kyb.inquiryId], ["pending", "inq_1"]);
  assert.equal(state().vendors[0].kyb?.inquiryId, "inq_1");
  const c = calls[0];
  assert.equal(c.url, "/api/v1/inquiries");
  assert.equal(c.headers["persona-version"], "2025-12-08");
  const attrs = (c.body.data as { attributes: Record<string, string> }).attributes;
  assert.equal(attrs["inquiry-template-id"], "itmpl_vendor_test");
  assert.match(attrs.note, /^bluvfi:default:vendor:Northwind Cloud Ltd$/);
  await assert.rejects(startVendorVerification("Nobody Ltd"), /Unknown vendor/);
});

test("if Persona does not return the link with the inquiry, it is asked for one", async () => {
  linkInCreate = false;
  const r = await startVendorVerification("Northwind Cloud Ltd");
  assert.match(r.link, /second=1/);
  assert.ok(calls.some((c) => c.url.endsWith("/generate-one-time-link")));
});

test("Persona's statuses map safely: only approved verifies, completed is still awaiting a decision", () => {
  assert.equal(mapStatus("approved"), "verified");
  for (const [p, ours] of [["completed", "submitted"], ["needs_review", "review"], ["declined", "declined"], ["failed", "declined"], ["expired", "expired"], ["created", "pending"], ["pending", "pending"], ["something_new", "pending"]]) assert.equal(mapStatus(p), ours, p);
});

test("webhook signatures: right secret passes; wrong secret, changed body, stale time and no header fail; a rotated pair passes", () => {
  const body = event("inq_1");
  const now = Date.now();
  const t = Math.floor(now / 1000);
  assert.equal(verifyPersonaSignature(body, sign(body), WEBHOOK_SECRET, now), true);
  assert.equal(verifyPersonaSignature(body, sign(body, "wbhsec_other"), WEBHOOK_SECRET, now), false);
  assert.equal(verifyPersonaSignature(body + " ", sign(body), WEBHOOK_SECRET, now), false);
  assert.equal(verifyPersonaSignature(body, sign(body, WEBHOOK_SECRET, t - 3600), WEBHOOK_SECRET, now), false, "an hour-old webhook is a replay");
  assert.equal(verifyPersonaSignature(body, "", WEBHOOK_SECRET, now), false);
  assert.equal(verifyPersonaSignature(body, sign(body), "", now), false, "no secret configured means nothing verifies");
  assert.equal(verifyPersonaSignature(body, `${sign(body, "wbhsec_old")} ${sign(body)}`, WEBHOOK_SECRET, now), true, "during rotation one of several pairs may match");
});

test("a webhook marks a vendor verified, but what counts is the decision Persona's API gives, not the event's words", async () => {
  await startVendorVerification("Northwind Cloud Ltd");
  inquiries.inq_1 = "declined"; // Persona says declined, though the (signed) event claims approved
  const r = await handlePersonaWebhook(event("inq_1", "inquiry.approved"), sign(event("inq_1", "inquiry.approved")));
  assert.equal(r.ok, true);
  assert.equal(state().vendors[0].kyb?.status, "declined");
  inquiries.inq_1 = "approved";
  await handlePersonaWebhook(event("inq_1"), sign(event("inq_1")));
  assert.equal(state().vendors[0].kyb?.status, "verified");
});

test("a forged webhook changes nothing and is refused by the route", async () => {
  await startVendorVerification("Northwind Cloud Ltd");
  inquiries.inq_1 = "approved";
  const body = event("inq_1");
  const bad = await webhookRoute(new Request("https://x.example/api/kyb/webhook", { method: "POST", headers: { "persona-signature": sign(body, "wbhsec_attacker") }, body }));
  assert.equal(bad.status, 401);
  assert.equal(state().vendors[0].kyb?.status, "pending");
  const good = await webhookRoute(new Request("https://x.example/api/kyb/webhook", { method: "POST", headers: { "persona-signature": sign(body) }, body }));
  assert.equal(good.status, 200);
  assert.equal(state().vendors[0].kyb?.status, "verified");
});

test("events for inquiries that are not ours, or are not inquiries, are ignored", async () => {
  const stranger = event("inq_999");
  assert.match((await handlePersonaWebhook(stranger, sign(stranger))).detail, /Not one of ours/);
  const other = JSON.stringify({ data: { attributes: { name: "account.created", payload: { data: { type: "account", id: "act_1" } } } } });
  assert.match((await handlePersonaWebhook(other, sign(other))).detail, /Ignored/);
});

test("an older inquiry cannot overwrite a newer one for the same vendor", async () => {
  await startVendorVerification("Northwind Cloud Ltd");
  await startVendorVerification("Northwind Cloud Ltd"); // inq_2 replaces inq_1
  inquiries.inq_1 = "approved";
  await refreshInquiry("inq_1");
  assert.equal(state().vendors[0].kyb?.inquiryId, "inq_2");
  assert.equal(state().vendors[0].kyb?.status, "pending");
});

test("vendor verification in the fraud checks follows the council's tiers: not asked below the threshold, required from it; declined blocks, verified is clear", async () => {
  const pay = async (no: string, amountUsd = 1240) => processInvoice(invoice({ invoiceNumber: no, amountUsd, poNumber: amountUsd === 1240 ? "PO-1" : "PO-BIG" }));
  const check = (p: Awaited<ReturnType<typeof pay>>) => p.checks.find((c) => c.id === "vendor_kyb")!;
  const small = check(await pay("INV-A"));
  assert.equal(small.verdict, "allow", "the default policy asks nothing of vendors under $5,000");
  assert.match(small.reason, /under \$5,000, the policy does not require it/);
  const big = check(await pay("INV-A2", 7000));
  assert.equal(big.verdict, "block");
  assert.match(big.reason, /requires a verified vendor from \$5,000/);
  // A policy written before tiers existed keeps the old rule: unverified warns, and a human decides.
  const { version, hash: _h, createdAt: _c, verifyVendorsFromUsd: _v, verifyNewVendors: _n, ...old } = currentPolicy();
  void _h; void _c; void _v; void _n;
  state().policies.push(makePolicy(version + 1, old));
  assert.equal(check(await pay("INV-A3")).verdict, "warn");
  await startVendorVerification("Northwind Cloud Ltd");
  state().vendors[0].kyb!.status = "declined";
  const declined = await pay("INV-B");
  assert.equal(check(declined).verdict, "block");
  assert.equal(declined.status, "blocked");
  state().vendors[0].kyb!.status = "verified";
  assert.equal(check(await pay("INV-C")).verdict, "allow");
});

test("a signed-up business cannot release payments until its own verification is approved; the operator's own business is exempt", async () => {
  const b = createBusiness("Gate Test Ltd", "owner@gate.test");
  const result = await runAs(b.id, async () => {
    seed();
    const first = await processInvoice(invoice({ invoiceNumber: "INV-G1" }));
    assert.equal(first.status, "blocked");
    assert.ok(first.checks.some((c) => c.id === "business_kyb" && c.verdict === "block" && /not been verified/.test(c.reason)));

    const { inquiryId } = await startBusinessVerification().then((r) => ({ inquiryId: r.kyb.inquiryId }));
    const waiting = await processInvoice(invoice({ invoiceNumber: "INV-G2" }));
    assert.equal(waiting.status, "blocked");
    assert.match(waiting.checks.find((c) => c.id === "business_kyb")!.reason, /pending/);
    return inquiryId;
  });
  inquiries[result] = "approved";
  const body = event(result);
  await handlePersonaWebhook(body, sign(body));
  assert.equal(getBusiness(b.id)!.kyb?.status, "verified");
  await runAs(b.id, async () => {
    const ok = await processInvoice(invoice({ invoiceNumber: "INV-G3" }));
    assert.ok(!ok.checks.some((c) => c.id === "business_kyb"), "verified: the gate is gone");
  });
  seed();
  const own = await processInvoice(invoice({ invoiceNumber: "INV-OWN" }));
  assert.ok(!own.checks.some((c) => c.id === "business_kyb"), "the operator's own business is exempt");
});

test("the API: a signer starts a vendor's verification; only an owner starts the business's", async () => {
  const cookie = `bluvfi_session=${encodeURIComponent((await issueSession("maya")) ?? "")}`;
  const call = (b: unknown) => kybRoute(new Request("https://x.example/api/kyb", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) }), undefined) as Promise<Response>;
  const ok = await call({ kind: "vendor", vendor: "Northwind Cloud Ltd" });
  assert.equal(ok.status, 200);
  assert.match(((await ok.json()) as { link: string }).link, /persona\.example/);
  const refreshed = await call({ kind: "vendor", vendor: "Northwind Cloud Ltd", refresh: true });
  assert.equal(((await refreshed.json()) as { kyb: { status: string } }).kyb.status, "pending");
  const biz = await call({ kind: "business" });
  assert.equal(biz.status, 400);
  assert.match(((await biz.json()) as { error: string }).error, /operator's own business/);
  assert.equal((await call({ kind: "other" })).status, 400);
});

test("short retention: documents are deleted at Persona once the decision has been final for the retention period, and only the verdict stays", async () => {
  await startVendorVerification("Northwind Cloud Ltd");
  inquiries.inq_1 = "approved";
  const body = event("inq_1");
  await handlePersonaWebhook(body, sign(body));
  const decided = state().vendors[0].kyb!;
  assert.equal(decided.status, "verified");
  assert.ok(decided.decidedAt, "the decision time is recorded");
  assert.equal(decided.redactedAt, undefined, "too early: kept for the retention period (7 days by default)");
  assert.ok(!calls.some((x) => x.method === "DELETE"));

  const day = 86_400_000;
  const early = await redactDue(Date.parse(decided.decidedAt!) + 6 * day);
  assert.deepEqual([early.redacted, early.waiting], [[], 1]);

  const later = await redactDue(Date.parse(decided.decidedAt!) + 8 * day);
  assert.deepEqual(later.redacted, ["inq_1"]);
  assert.ok(calls.some((x) => x.method === "DELETE" && x.url === "/api/v1/inquiries/inq_1"), "Persona was asked to delete it");
  assert.ok(state().vendors[0].kyb!.redactedAt, "the record says when the documents were deleted");
  assert.equal(state().vendors[0].kyb!.status, "verified", "the verdict stays");

  // Once done it is not asked again, and a refresh keeps both the decision time and the deletion.
  const n = calls.filter((x) => x.method === "DELETE").length;
  await redactDue(Date.parse(decided.decidedAt!) + 30 * day);
  assert.equal(calls.filter((x) => x.method === "DELETE").length, n);
  await refreshInquiry("inq_1");
  assert.equal(state().vendors[0].kyb!.decidedAt, decided.decidedAt);
  assert.ok(state().vendors[0].kyb!.redactedAt);
});
