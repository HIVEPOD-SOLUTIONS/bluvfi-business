import { HAS_PARTNER_KEY } from "./setup-confidential";
import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, keyToImplicitAddress } from "near-api-js";
import {
  authenticate, confidentialBalances, confidentialQuote, confidentialStatus, currentSalt, generateIntent, intentHash, submitIntent, daoDerivedKey, intentsNonce, loginMessage, loginWithKey, nep413Hash, prepareLogin, refreshTokens, signProposal, signWithKey,
} from "../../lib/confidential";

/** Confidential treasuries against the real 1Click test host. A throwaway key logs in; nothing is funded or sent. */
const T = { timeout: 120_000 };
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as { account_id: string; exp: number; iat: number };

const throwaway = () => {
  const key = KeyPair.fromRandom("ed25519");
  return { key, account: keyToImplicitAddress(key.getPublicKey().toString()) };
};

test("intents.near gives a four-byte salt, and a nonce built on it has the layout Intents verifies", T, async () => {
  const salt = await currentSalt();
  assert.equal(salt.length, 4);
  const n = intentsNonce(salt, 60_000, 1_700_000_000_000);
  assert.deepEqual([...n.subarray(0, 4)], [0x56, 0x28, 0xf6, 0xc6]);
  assert.equal(n[4], 0, "version 0");
  assert.deepEqual(n.subarray(5, 9), salt);
  const ns = (ms: number) => BigInt(ms) * BigInt(1_000_000);
  assert.equal(n.readBigUInt64LE(17), ns(1_700_000_000_000), "created at");
  assert.equal(n.readBigUInt64LE(9), ns(1_700_000_000_000 + 60_000), "deadline");
});

test("an account logs in by signing a NEP-413 login with its own key, and the session is for that account", T, async () => {
  const { key, account } = throwaway();
  const tokens = await loginWithKey(account, key);
  assert.equal(tokens.expiresIn, 900, "the access token lasts fifteen minutes");
  assert.equal(tokens.refreshExpiresIn, 7 * 24 * 3600, "the refresh token lasts a week");
  assert.equal(claims(tokens.accessToken).account_id, account);
  // The balance read works with that session, and a fresh account holds nothing.
  assert.deepEqual(await confidentialBalances(tokens.accessToken), []);

  // A refresh token gets a new access token for the same account, so a council logs in about weekly, not every quarter hour.
  const next = await refreshTokens(tokens.refreshToken);
  assert.equal(claims(next.accessToken).account_id, account);
});

test("a login that is tampered with, signed by another key, for another account, or built on a stale salt is refused", T, async () => {
  const { key, account } = throwaway();
  const fresh = async () => intentsNonce(await currentSalt());

  // The honest login works.
  assert.ok((await authenticate(signWithKey(key, loginMessage(account), await fresh()))).accessToken);

  // The message was changed after signing.
  const s1 = signWithKey(key, loginMessage(account), await fresh());
  await assert.rejects(authenticate({ ...s1, payload: { ...s1.payload, message: loginMessage(account, 3_600_000) } }), /401/);
  // The signature belongs to a different key than the one named.
  const s2 = signWithKey(key, loginMessage(account), await fresh());
  await assert.rejects(authenticate({ ...s2, public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString() }), /401/);
  // Someone else's account in the message: a key can only log in the account it is.
  await assert.rejects(authenticate(signWithKey(key, loginMessage(throwaway().account), await fresh())), /401/);
  // A salt intents.near no longer accepts.
  await assert.rejects(authenticate(signWithKey(key, loginMessage(account), intentsNonce(Buffer.from("00000000", "hex")))), /401/);
  // Not asserted, because the live host does not enforce them: a login can be replayed, and the message's own deadline is not checked.
});

test("a council's login is prepared as a hash for the MPC signer: the DAO's derived key is real and per DAO", T, async () => {
  const a = await daoDerivedKey("acme-treasury.sputnik-dao.near");
  const b = await daoDerivedKey("acme-treasury.sputnik-dao.near");
  const c = await daoDerivedKey("bolt-treasury.sputnik-dao.near");
  assert.match(a, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(a, b, "the same DAO always derives the same key");
  assert.notEqual(a, c, "another DAO derives another key");

  const prep = await prepareLogin("acme-treasury.sputnik-dao.near");
  assert.match(prep.hashHex, /^[0-9a-f]{64}$/);
  // The hash is exactly NEP-413's hash of the message and nonce, so the signature the MPC returns verifies on 1Click.
  assert.equal(prep.hashHex, nep413Hash(prep.message, Buffer.from(prep.nonce, "base64"), "intents.near").toString("hex"));

  // The proposal that asks v1.signer to sign it: a call with 1 yoctoNEAR the agent can file and the council executes.
  const proposal = signProposal("acme-treasury.sputnik-dao.near", prep.hashHex);
  assert.equal(proposal.FunctionCall.receiver_id, "v1.signer");
  const action = proposal.FunctionCall.actions[0];
  assert.deepEqual([action.method_name, action.deposit], ["sign", "1"]);
  assert.deepEqual(JSON.parse(Buffer.from(action.args, "base64").toString()), { request: { payload_v2: { Eddsa: prep.hashHex }, path: "acme-treasury.sputnik-dao.near", domain_id: 1 } });
  assert.throws(() => signProposal("acme-treasury.sputnik-dao.near", "not-a-hash"), /32 bytes of hex/);
});

test("a confidential payout runs the whole path on the live host: quote, intent, signature, submission, and an empty account's payout fails safely", { ...T, skip: HAS_PARTNER_KEY ? false : "Needs your 1Click partner key in .env.local (ONECLICK_JWT)" }, async () => {
  const { key, account } = throwaway();
  const { accessToken } = await loginWithKey(account, key);
  const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const ETH_USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
  const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  // A quote funded from the account's confidential balance: its deposit address is a confidential account, and the price is real.
  const quote = await confidentialQuote(accessToken, { account, originAsset: NEAR_USDC, destinationAsset: ETH_USDC, amountOutRaw: "5000000", recipient: ETH });
  assert.match(quote.depositAddress, /^[0-9a-f]{64}$/);
  // Confidential routing costs more than a public payout (about 13% over on a $5 payment at the time of writing; a public one was about 7%).
  assert.ok(Number(quote.amountIn) >= 5 && Number(quote.amountIn) < 6.5, "a priced quote for the 5 USDC out: " + quote.amountIn);

  // The intent to sign: a transfer of the shielded (imt:) token to that deposit address, from this account, addressed to the Confidential Intents verifier.
  const intent = await generateIntent(accessToken, account, quote.depositAddress);
  assert.equal(intent.standard, "nep413");
  assert.equal(intent.payload.recipient, "intents.far", "the verifier for confidential intents, not intents.near");
  const message = JSON.parse(intent.payload.message) as { signer_id: string; intents: { intent: string; receiver_id: string; tokens: Record<string, string> }[] };
  assert.equal(message.signer_id, account);
  assert.equal(message.intents.length, 1);
  assert.equal(message.intents[0].intent, "transfer");
  assert.equal(message.intents[0].receiver_id, quote.depositAddress);
  const [token, amount] = Object.entries(message.intents[0].tokens)[0];
  assert.match(token, /^imt:[0-9a-f]{64}:nep141:/);
  assert.equal(Number(amount) / 1e6, Number(quote.amountIn), "it moves exactly what the quote asks for");

  // Sign it (a DAO's MPC signer signs this same hash) and submit.
  const hash = intentHash(intent);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const signed = signWithKey(key, intent.payload.message, Buffer.from(intent.payload.nonce, "base64"), intent.payload.recipient);
  const intentHashSubmitted = await submitIntent(accessToken, intent, signed.public_key, signed.signature);
  assert.ok(intentHashSubmitted.length > 20, "1Click accepted the intent and returned its hash");

  // The account holds nothing, so the payout cannot run: it is picked up, then fails, and no funds moved.
  let status = "";
  for (let i = 0; i < 10 && !/^(FAILED|REFUNDED|SUCCESS)$/.test(status); i++) {
    await new Promise((r) => setTimeout(r, 6000));
    status = (await confidentialStatus(accessToken, quote.depositAddress)).status;
  }
  assert.equal(status, "FAILED", "an empty account's payout ends FAILED");
  assert.deepEqual(await confidentialBalances(accessToken), [], "still nothing in the account");
});
