import { APP_ID, OWNER, PRIVY_PORT, SECRET } from "./setup-privy";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { POST as loginPrivy } from "../app/api/login/privy/route";
import { DELETE as removeTeam, POST as addTeam } from "../app/api/team/route";
import { approveProposal, propose } from "../lib/governance";
import { COOKIE, verifySession } from "../lib/session";
import { resetRegistry } from "../lib/business";
import { addMember, approvalThreshold, privyEmails, removeMember, signerNames } from "../lib/team";
import { currentPolicy, resetState } from "../lib/store";

const APPROVER = "dev@acme.test";
const emailsByUser: Record<string, { type: string; address?: string; email?: string }[]> = {
  "did:privy:owner": [{ type: "email", address: "Owner@Acme.test" }],
  "did:privy:dev": [{ type: "google_oauth", email: APPROVER }],
  "did:privy:stranger": [{ type: "email", address: "stranger@elsewhere.test" }],
};

let server: Server;
let key: KeyLike;
let lookups = 0;

const token = async (sub: string, over: { key?: KeyLike; aud?: string; iss?: string; exp?: number } = {}) =>
  new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject(sub).setIssuer(over.iss ?? "privy.io").setAudience(over.aud ?? APP_ID)
    .setIssuedAt().setExpirationTime(over.exp ?? Math.floor(Date.now() / 1000) + 3600).sign(over.key ?? key);

before(async () => {
  const pair = await generateKeyPair("ES256");
  key = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  server = createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === `/api/v1/apps/${APP_ID}/jwks.json`) return send(200, { keys: [jwk] });
    const m = req.url?.match(/^\/v1\/users\/(.+)$/);
    if (!m) return send(404, {});
    lookups++;
    const want = `Basic ${Buffer.from(`${APP_ID}:${SECRET}`).toString("base64")}`;
    if (req.headers.authorization !== want || req.headers["privy-app-id"] !== APP_ID) return send(401, { error: "bad app credentials" });
    const accounts = emailsByUser[decodeURIComponent(m[1])];
    return accounts ? send(200, { id: decodeURIComponent(m[1]), linked_accounts: accounts }) : send(404, {});
  });
  await new Promise<void>((ok) => server.listen(PRIVY_PORT, "127.0.0.1", ok));
});
after(() => { server.close(); });
beforeEach(() => { resetState(); resetRegistry(); lookups = 0; });

const post = (url: string, body: unknown, cookie?: string, method = "POST") =>
  new Request(`http://app.test${url}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) }, body: JSON.stringify(body) });
// The cookie exactly as a browser sends it back (percent-encoded); the session check sees it decoded.
const who = (cookie: string | undefined) => verifySession(cookie === undefined ? undefined : decodeURIComponent(cookie));
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];

test("an owner signs in with a verified Privy login and gets a session named by their email", async () => {
  const res = await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:owner") }));
  assert.equal(res.status, 200);
  assert.equal(await who(cookieOf(res)), OWNER);
  assert.equal(lookups, 1);
});

test("a Privy account that is not on the team gets nothing, even with a valid login", async () => {
  const res = await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:stranger") }));
  assert.equal(res.status, 401);
  const out = (await res.json()) as { error: string; signup?: boolean };
  assert.match(out.error, /stranger@elsewhere.test is not on any business's team yet/);
  assert.equal(out.signup, true);
  assert.equal(cookieOf(res), undefined);
});

test("tokens that are forged, for another app, from another issuer or expired are refused before any lookup", async () => {
  const other = (await generateKeyPair("ES256")).privateKey;
  const bad = [
    await token("did:privy:owner", { key: other }),
    await token("did:privy:owner", { aud: "someone-elses-app" }),
    await token("did:privy:owner", { iss: "evil.example" }),
    await token("did:privy:owner", { exp: Math.floor(Date.now() / 1000) - 60 }),
    "not-a-jwt",
    "",
  ];
  for (const t of bad) await assert.rejects(privyEmails(t), /could not be verified/);
  assert.equal(lookups, 0);
});

test("an owner adds an approver by email, who can then sign in; removing them ends their session at once", async () => {
  const owner = cookieOf(await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:owner") })))!;
  const add = await addTeam(post("/api/team", { email: " Dev@Acme.test " }, owner), undefined);
  assert.equal(add.status, 200);
  assert.deepEqual(signerNames(), [OWNER, APPROVER]);

  const dev = cookieOf(await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:dev") })))!;
  assert.equal(await who(dev), APPROVER);

  const rm = await removeTeam(post("/api/team", { email: APPROVER }, owner, "DELETE"), undefined);
  assert.equal(rm.status, 200);
  assert.equal(await who(dev), null);
  assert.equal((await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:dev") }))).status, 401);
});

test("an approver cannot add or remove people, and an owner cannot be removed", async () => {
  addMember(OWNER, APPROVER);
  const dev = cookieOf(await loginPrivy(post("/api/login/privy", { accessToken: await token("did:privy:dev") })))!;
  const res = await addTeam(post("/api/team", { email: "x@acme.test" }, dev), undefined);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Only an owner/);
  assert.throws(() => removeMember(APPROVER, OWNER), /Only an owner/);
  assert.throws(() => removeMember(OWNER, OWNER), /cannot be removed here/);
  assert.throws(() => addMember(OWNER, "not-an-email"), /valid email/);
  assert.throws(() => addMember(OWNER, "DEV@acme.test"), /already on the team/);
});

test("a policy change needs two different people, and works with email signers", () => {
  addMember(OWNER, APPROVER);
  assert.equal(approvalThreshold(), 2);
  const body = Object.fromEntries(Object.entries(currentPolicy()).filter(([k]) => !["version", "hash", "createdAt"].includes(k))) as Parameters<typeof propose>[0];
  const p = propose({ ...body, perPaymentLimitUsd: 123 }, OWNER);
  assert.equal(p.status, "open");
  assert.throws(() => approveProposal(p.id, "mallory@acme.test"), /Unknown signer/);
  assert.equal(approveProposal(p.id, OWNER).status, "open"); // the same person twice is still one
  assert.equal(approveProposal(p.id, APPROVER).status, "applied");
  assert.equal(currentPolicy().perPaymentLimitUsd, 123);
});

test("a lookup failure on Privy's side is reported, not swallowed", async () => {
  emailsByUser["did:privy:owner"] = undefined as never;
  try {
    await assert.rejects(privyEmails(await token("did:privy:owner")), /would not look up this user \(404\)/);
  } finally {
    emailsByUser["did:privy:owner"] = [{ type: "email", address: "Owner@Acme.test" }];
  }
});
