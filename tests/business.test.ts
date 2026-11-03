import { APP_ID, OWNER, PRIVY_PORT, SECRET } from "./setup-privy";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { POST as loginPrivy } from "../app/api/login/privy/route";
import { POST as signup } from "../app/api/signup/route";
import { GET as getTeam, POST as addTeam } from "../app/api/team/route";
import { POST as postReceivable } from "../app/api/receivables/route";
import { POST as payRoute } from "../app/api/pay/[id]/route";
import { POST as auditPost } from "../app/api/audit/[kind]/route";
import { openWithKey, createGrant } from "../lib/audit";
import { businesses, cfg, createBusiness, resetRegistry, setTreasury } from "../lib/business";
import { COOKIE, verifySessionFull } from "../lib/session";
import { resetAllState, state } from "../lib/store";
import { addMember, removeMember, signerNames } from "../lib/team";
import { bizOfId, DEFAULT_BIZ, runAs } from "../lib/tenant";

/**
 * Many businesses on one platform: each has its own records, team and treasury settings, and nothing one does can
 * reach another. Privy is again a local server speaking its two endpoints, with tokens signed by a real ES256 key.
 */
const users: Record<string, { type: string; address?: string; email?: string }[]> = {
  "did:privy:ada": [{ type: "email", address: "ada@acme.test" }],
  "did:privy:bob": [{ type: "google_oauth", email: "bob@bolt.test" }],
  "did:privy:owner": [{ type: "email", address: OWNER }],
};
let server: Server;
let key: KeyLike;

const token = async (sub: string) =>
  new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(sub).setIssuer("privy.io").setAudience(APP_ID).setIssuedAt().setExpirationTime("1h").sign(key);

before(async () => {
  const pair = await generateKeyPair("ES256");
  key = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  server = createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === `/api/v1/apps/${APP_ID}/jwks.json`) return send(200, { keys: [jwk] });
    const m = req.url?.match(/^\/v1\/users\/(.+)$/);
    const accounts = m && users[decodeURIComponent(m[1])];
    if (!accounts || req.headers.authorization !== `Basic ${Buffer.from(`${APP_ID}:${SECRET}`).toString("base64")}`) return send(404, {});
    return send(200, { linked_accounts: accounts });
  });
  await new Promise<void>((ok) => server.listen(PRIVY_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { resetAllState(); resetRegistry(); });

// Each request comes from its own address, so the per-address rate limits do not trip across tests.
let n = 0;
const post = (url: string, body: unknown, cookie?: string, method = "POST") =>
  new Request(`http://app.test${url}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(++n / 250)}.${n % 250}`, ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body) });
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
const who = (c: string | undefined) => verifySessionFull(c === undefined ? undefined : decodeURIComponent(c));

async function signUp(did: string, name: string) {
  const res = await signup(post("/api/signup", { accessToken: await token(did), businessName: name }));
  assert.equal(res.status, 200);
  const cookie = cookieOf(res)!;
  const session = (await who(cookie))!;
  return { cookie, biz: session.biz, name: session.name };
}

test("a person with no business signs up, becomes its owner, and gets a session for that business alone", async () => {
  const miss = await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:ada") }));
  assert.equal(miss.status, 401);
  assert.equal(((await miss.json()) as { signup?: boolean }).signup, true);

  const ada = await signUp("did:privy:ada", "Acme Ltd");
  assert.match(ada.biz, /^bz_[0-9a-f]{10}$/);
  assert.equal(ada.name, "ada@acme.test");
  assert.deepEqual(businesses().filter((b) => b.id === ada.biz).map((b) => b.team), [[{ email: "ada@acme.test", role: "owner", addedAt: businesses().find((b) => b.id === ada.biz)!.team[0].addedAt }]]);

  // Signing in again finds the same business.
  const again = await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:ada") }));
  assert.equal(again.status, 200);
  assert.equal((await who(cookieOf(again)))!.biz, ada.biz);
});

test("each business has its own records: one cannot see or touch another's", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  const b = await signUp("did:privy:bob", "Bolt Inc");
  runAs(a.biz, () => { state().killSwitch = true; state().vendors.push({ name: "Only Acme" } as never); });
  runAs(b.biz, () => { assert.equal(state().killSwitch, false); assert.deepEqual(state().vendors, []); });
  assert.equal(state().killSwitch, false); // the operator's own business
  assert.deepEqual(state().vendors, []);
});

test("each business has its own treasury settings, kept encrypted, and none falls back to another's", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  const b = await signUp("did:privy:bob", "Bolt Inc");
  assert.equal(runAs(a.biz, () => cfg().CUSTODY), "manual");
  assert.equal(runAs(a.biz, () => cfg().TREASURY_ACCOUNT), "");

  const secret = "ed25519:3tTn7rXk8mSecretSecretSecretSecretSecretSecretSecretSecretSecretSecret";
  setTreasury(a.biz, { custody: "sputnik", dao: "acme.sputnik-dao.near", agent: "acme-agent.near", agentKey: secret, treasury: "acme.sputnik-dao.near" });
  const acme = runAs(a.biz, () => cfg());
  assert.deepEqual([acme.CUSTODY, acme.DAO_ACCOUNT, acme.AGENT_PRIVATE_KEY, acme.DAO_CUSTODY, acme.POLICY_VIA_DAO], ["sputnik", "acme.sputnik-dao.near", secret, true, true]);
  // At rest the key is not in the clear.
  assert.ok(!JSON.stringify(businesses()).includes(secret));
  // Bolt and the operator see nothing of it.
  assert.equal(runAs(b.biz, () => cfg().DAO_ACCOUNT), "");
  assert.equal(runAs(b.biz, () => cfg().AGENT_PRIVATE_KEY), "");
  assert.equal(cfg().DAO_ACCOUNT, "");
  assert.equal(runAs(DEFAULT_BIZ, () => cfg().AGENT_PRIVATE_KEY), "");
});

test("a pay link finds its business from the link alone, with no login, and no other business can serve it", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  setTreasury(a.biz, { custody: "manual", treasury: "acme.near" });
  const made = await postReceivable(post("/api/receivables", { client: "Zed", amountUsd: 50 }, a.cookie), undefined);
  assert.equal(made.status, 200);
  const id = ((await made.json()) as { receivable: { id: string; payTo: string } }).receivable;
  assert.match(id.id, /^bz_[0-9a-f]{10}~rcv-/);
  assert.equal(id.payTo, "acme.near");
  assert.equal(bizOfId(id.id), a.biz);

  // Public: no cookie. It reaches Acme's invoice (so the error is about its deposit, not about a missing invoice).
  const hit = await payRoute(post(`/api/pay/${id.id}`, { check: true }), { params: Promise.resolve({ id: id.id }) });
  assert.match(((await hit.json()) as { error: string }).error, /No payment has been started/);
  // The same invoice id, forced into another business, does not exist there.
  const bare = id.id.split("~")[1];
  const miss = await payRoute(post(`/api/pay/${bare}`, { check: true }), { params: Promise.resolve({ id: bare }) });
  assert.match(((await miss.json()) as { error: string }).error, /Invoice not found/);
});

test("auditor view keys open only the business that issued them", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  const b = await signUp("did:privy:bob", "Bolt Inc");
  const g = runAs(a.biz, () => createGrant("Auditor LLP", 7));
  assert.match(g.plainKey, new RegExp(`^${a.biz}~`));
  const opened = openWithKey(g.plainKey);
  assert.equal(opened.ok, true);
  assert.equal(opened.ok && opened.grantee, "Auditor LLP");
  // Without the business prefix, the bare key opens nothing anywhere else.
  const bare = g.plainKey.split("~")[1];
  assert.equal(openWithKey(bare).ok, false);
  assert.equal(runAs(b.biz, () => openWithKey(bare)).ok, false);
  // Over the API, a signed-in signer of another business cannot revoke it either.
  const res = await auditPost(post("/api/audit/revoke", { id: g.id }, b.cookie), { params: Promise.resolve({ kind: "revoke" }) });
  assert.equal(res.status, 200);
  assert.equal(runAs(a.biz, () => state().grants[0].revoked), false);
});

test("the team is per business: an API call shows and changes only its own business's team", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  const b = await signUp("did:privy:bob", "Bolt Inc");
  assert.equal((await addTeam(post("/api/team", { email: "cara@acme.test", role: "approver" }, a.cookie), undefined)).status, 200);
  const acme = (await (await getTeam(post("/api/team", undefined, a.cookie, "GET"), undefined)).json()) as { members: { email: string }[] };
  const bolt = (await (await getTeam(post("/api/team", undefined, b.cookie, "GET"), undefined)).json()) as { members: { email: string }[] };
  assert.deepEqual(acme.members.map((m) => m.email), ["ada@acme.test", "cara@acme.test"]);
  assert.deepEqual(bolt.members.map((m) => m.email), ["bob@bolt.test"]);
  // Ada is not an owner of Bolt, so she cannot add anyone there, even by naming Bolt's signer.
  assert.throws(() => runAs(b.biz, () => addMember("ada@acme.test", "x@bolt.test")), /Only an owner/);
  assert.deepEqual(runAs(a.biz, () => signerNames()), ["ada@acme.test", "cara@acme.test"]);
});

test("someone on two businesses chooses which to sign in to; leaving one ends only that session", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  const b = createBusiness("Bolt Inc", "bob@bolt.test");
  runAs(b.id, () => addMember("bob@bolt.test", "ada@acme.test"));

  const ask = await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:ada") }));
  assert.equal(ask.status, 200);
  const choose = ((await ask.json()) as { choose: { id: string; name: string }[] }).choose;
  assert.deepEqual(choose.map((c) => c.name).sort(), ["Acme Ltd", "Bolt Inc"]);

  const boltSession = cookieOf(await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:ada"), businessId: b.id })))!;
  assert.equal((await who(boltSession))!.biz, b.id);
  assert.equal((await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:ada"), businessId: "bz_0000000000" }))).status, 401);

  runAs(b.id, () => removeMember("bob@bolt.test", "ada@acme.test"));
  assert.equal(await who(boltSession), null);
  assert.equal((await who(a.cookie))!.biz, a.biz);
});

test("a business always keeps an owner, and the operator's own business still works from the environment", async () => {
  const a = await signUp("did:privy:ada", "Acme Ltd");
  assert.throws(() => runAs(a.biz, () => removeMember("ada@acme.test", "ada@acme.test")), /at least one owner/);
  const owner = cookieOf(await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:owner") })))!;
  assert.deepEqual(await who(owner), { biz: DEFAULT_BIZ, name: OWNER });
});
