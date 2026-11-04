import { createHash, randomBytes } from "node:crypto";
import { serialize } from "borsh";
import { ed25519 } from "@noble/curves/ed25519.js";
import { baseDecode, baseEncode, type KeyPair } from "near-api-js";
import { NETWORK, ONECLICK_BASE, ONECLICK_JWT } from "./config";
import { viewFn } from "./custody";

/**
 * Confidential treasuries: a Sputnik DAO whose funds are shielded in 1Click's Confidential Intents (the layer behind
 * NEAR Business and Trezu's confidential treasuries). Balances are not on a public chain; they are read through 1Click
 * with a login that proves control of the account. A DAO has no key, so the council approves a proposal that asks the
 * MPC signer (`v1.signer`) to sign, and the signature is what logs the DAO in and authorises each confidential payout.
 *
 * What is here is checked against the live 1Click API (see tests/real/confidential.test.ts): the NEP-413 login with a
 * throwaway key, the nonce layout, the salt read from `intents.near`, token refresh and the balance read. The DAO's
 * MPC key and the proposal that asks for a signature are built here too; the council's side runs on mainnet.
 */
export const CONFIDENTIAL_BASE = (process.env.CONFIDENTIAL_API_URL ?? ONECLICK_BASE).replace(/\/$/, "");
export const INTENTS_CONTRACT = "intents.near";
/** NEAR's MPC signer. On testnet it is `v1.signer-prod.testnet`; Confidential Intents itself only exists on mainnet. */
export const SIGNER_CONTRACT = process.env.MPC_SIGNER_CONTRACT ?? (NETWORK === "testnet" ? "v1.signer-prod.testnet" : "v1.signer");
/** The `v1.signer` domain that signs with ed25519, the key type Confidential Intents verifies. */
export const ED25519_DOMAIN = 1;

/** The first four bytes of an Intents nonce. */
const NONCE_MAGIC = Buffer.from([0x56, 0x28, 0xf6, 0xc6]);

/** The salt `intents.near` currently requires in nonces (four bytes). It rotates, so it is read each time. */
export async function currentSalt(): Promise<Buffer> {
  const hex = await viewFn<string>(INTENTS_CONTRACT, "current_salt");
  const salt = Buffer.from(hex, "hex");
  if (salt.length !== 4) throw new Error(`intents.near returned a salt of ${salt.length} bytes, expected 4`);
  return salt;
}

/** A 32-byte Intents nonce: magic, version 0, the salt, the deadline and the creation time in nanoseconds (little-endian), seven random bytes. */
export function intentsNonce(salt: Buffer, ttlMs = 10 * 60_000, nowMs = Date.now()): Buffer {
  const n = Buffer.alloc(32);
  NONCE_MAGIC.copy(n, 0);
  n[4] = 0;
  salt.copy(n, 5);
  const NS_PER_MS = BigInt(1_000_000); // the project's TypeScript target does not allow BigInt literals such as 1n
  const now = BigInt(nowMs) * NS_PER_MS;
  n.writeBigUInt64LE(now + BigInt(ttlMs) * NS_PER_MS, 9);
  n.writeBigUInt64LE(now, 17);
  randomBytes(7).copy(n, 25);
  return n;
}

/** NEP-413's signing hash: sha256(u32le(2^31 + 413) || borsh({ message, nonce, recipient, callbackUrl })). */
export function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl: string | null = null): Buffer {
  const schema = { struct: { message: "string", nonce: { array: { type: "u8", len: 32 } }, recipient: "string", callbackUrl: { option: "string" } } };
  const body = serialize(schema, { message, nonce: Array.from(nonce), recipient, callbackUrl });
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2_147_484_061);
  return createHash("sha256").update(Buffer.concat([tag, Buffer.from(body)])).digest();
}

/** What an account signs to log in: an Intents message with no intents in it, so signing it moves nothing. */
export function loginMessage(signerId: string, ttlMs = 10 * 60_000): string {
  return JSON.stringify({ signer_id: signerId, deadline: new Date(Date.now() + ttlMs).toISOString(), intents: [] });
}

export interface Nep413SignedData {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: string; callbackUrl?: string };
  public_key: string;
  signature: string;
}

/** The login a council signs for its DAO: the message, the nonce and the hash the MPC signer is asked to sign. */
export async function prepareLogin(signerId: string): Promise<{ message: string; nonce: string; hashHex: string }> {
  const message = loginMessage(signerId);
  const nonce = intentsNonce(await currentSalt());
  return { message, nonce: nonce.toString("base64"), hashHex: nep413Hash(message, nonce, INTENTS_CONTRACT).toString("hex") };
}

/** Sign a login (or any NEP-413 payload) with a key we hold. For an account with its own key; a DAO's is signed by MPC. */
export function signWithKey(key: KeyPair, message: string, nonce: Buffer, recipient = INTENTS_CONTRACT): Nep413SignedData {
  const sig = key.sign(nep413Hash(message, nonce, recipient));
  return {
    standard: "nep413",
    payload: { message, nonce: nonce.toString("base64"), recipient },
    public_key: key.getPublicKey().toString(),
    signature: `ed25519:${baseEncode(sig.signature)}`,
  };
}

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number }

/** The partner key 1Click issues you. Confidential quotes are refused without it; the account's own login goes in `Authorization`. */
const partner = (): Record<string, string> => (ONECLICK_JWT ? { "x-api-key": ONECLICK_JWT } : {});

const post = async <T,>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> => {
  const res = await fetch(`${CONFIDENTIAL_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...partner(), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path} failed (${res.status}): ${(JSON.parse(text || "{}") as { message?: string }).message ?? text.slice(0, 160)}`);
  return JSON.parse(text) as T;
};

/** Exchange a signed login for session tokens (the access token lasts about 15 minutes, the refresh token about a week). */
export const authenticate = (signedData: Nep413SignedData) => post<Tokens>("/v0/auth/authenticate", { signedData });

/** A new access token from a refresh token, so a council signs a login about once a week, not every quarter hour. */
export const refreshTokens = (refreshToken: string) => post<Tokens>("/v0/auth/refresh", { refreshToken });

/** Log in an account whose key we hold. */
export async function loginWithKey(signerId: string, key: KeyPair): Promise<Tokens> {
  const message = loginMessage(signerId);
  return authenticate(signWithKey(key, message, intentsNonce(await currentSalt())));
}

export interface ConfidentialBalance { tokenId: string; amount: string }

/** The shielded balances of the account the token belongs to. Not visible on any public chain, so this is the only way to see them. */
export async function confidentialBalances(accessToken: string): Promise<ConfidentialBalance[]> {
  const res = await fetch(`${CONFIDENTIAL_BASE}/v0/account/balances`, { headers: { ...partner(), authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`1Click balances failed (${res.status})`);
  const j = (await res.json()) as { balances?: { tokenId?: string; token?: string; amount?: string }[] };
  return (j.balances ?? []).map((b) => ({ tokenId: String(b.tokenId ?? b.token ?? ""), amount: String(b.amount ?? "0") }));
}

/** The ed25519 key the MPC signer derives for this DAO: the account Confidential Intents checks the DAO's signatures against. */
export const daoDerivedKey = (dao: string) =>
  viewFn<string>(SIGNER_CONTRACT, "derived_public_key", { path: dao, predecessor: dao, domain_id: ED25519_DOMAIN });

/**
 * The DAO proposal that asks `v1.signer` to sign `hashHex` with the DAO's derived key. The agent can file it (it only
 * proposes); the council's approval is what executes it, and the signature comes back in the execution result.
 */
export function signProposal(dao: string, hashHex: string, signer = SIGNER_CONTRACT) {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error("The hash to sign must be 32 bytes of hex");
  const args = { request: { payload_v2: { Eddsa: hashHex }, path: dao, domain_id: ED25519_DOMAIN } };
  return {
    FunctionCall: {
      receiver_id: signer,
      actions: [{ method_name: "sign", args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "1", gas: "250000000000000" }],
    },
  };
}

interface Outcome { receipts_outcome?: { outcome: { status: unknown } }[] }

/**
 * The MPC signature in the execution outcome of the council vote that executed a `sign` proposal. `v1.signer.sign` returns
 * `{"scheme":"Ed25519","signature":[64 bytes]}` from one of the transaction's receipts, which is where the council's last
 * vote shows it (found on a real testnet DAO). Undefined if this transaction carried none.
 */
export function mpcSignature(outcome: Outcome): string | undefined {
  for (const r of outcome.receipts_outcome ?? []) {
    const status = r.outcome.status as { SuccessValue?: string } | string;
    const value = typeof status === "object" ? status.SuccessValue : undefined;
    if (!value) continue;
    try {
      const j = JSON.parse(Buffer.from(value, "base64").toString()) as { scheme?: string; signature?: number[] };
      if (j.scheme === "Ed25519" && Array.isArray(j.signature) && j.signature.length === 64) return `ed25519:${baseEncode(Uint8Array.from(j.signature))}`;
    } catch {
      /* not a signature receipt */
    }
  }
  return undefined;
}

/** Does this signature sign this hash under this key? The check Confidential Intents makes, so a bad signature is caught before anything is submitted. */
export function verifyMpcSignature(hashHex: string, signature: string, publicKey: string): boolean {
  const strip = (s: string) => s.replace(/^ed25519:/, "");
  try {
    return ed25519.verify(baseDecode(strip(signature)), Buffer.from(hashHex, "hex"), baseDecode(strip(publicKey)));
  } catch {
    return false;
  }
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

/** The Confidential Intents verifier the signed intent is addressed to, as 1Click reports it. It is not `intents.near`, which is only used for logins. */
export interface GeneratedIntent { standard: string; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string } }

export interface ConfidentialQuote { depositAddress: string; deadline: string; amountIn: string; amountOut: string }

/**
 * A quote to pay `amountOutRaw` of `destinationAsset` to `recipient` on its own chain, funded from the account's confidential
 * balance (origin asset `originAsset`, USDC on NEAR for us). Needs the account's login and the partner key. The deposit address
 * it returns is a confidential-intents account: it is funded by a signed transfer intent, never by sending tokens to it.
 */
export async function confidentialQuote(accessToken: string, q: { account: string; originAsset: string; destinationAsset: string; amountOutRaw: string; recipient: string; deadlineMs?: number }): Promise<ConfidentialQuote> {
  const j = await post<{ quote?: { depositAddress?: string; deadline?: string; amountInFormatted?: string; amountOutFormatted?: string } }>(
    "/v0/quote",
    {
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: q.originAsset,
      depositType: "CONFIDENTIAL_INTENTS",
      destinationAsset: q.destinationAsset,
      amount: q.amountOutRaw,
      refundTo: q.account,
      refundType: "CONFIDENTIAL_INTENTS",
      recipient: q.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + (q.deadlineMs ?? 3_600_000)).toISOString(),
    },
    bearer(accessToken)
  );
  if (!j.quote?.depositAddress) throw new Error("1Click returned no deposit address for the confidential quote");
  return { depositAddress: j.quote.depositAddress, deadline: j.quote.deadline ?? "", amountIn: j.quote.amountInFormatted ?? "", amountOut: j.quote.amountOutFormatted ?? "" };
}

/**
 * A quote to shield `amountRaw` of an asset: move it 1:1 from the account's public Intents balance into its confidential one (no fee,
 * found live). Like a payout it is funded by a signed transfer intent, here of the public token. Deposit first, by sending the token to
 * `intents.near` with `ft_transfer_call` (message: the receiving account).
 */
export async function shieldQuote(accessToken: string, q: { account: string; assetId: string; amountRaw: string; deadlineMs?: number }): Promise<ConfidentialQuote> {
  const j = await post<{ quote?: { depositAddress?: string; deadline?: string; amountInFormatted?: string; amountOutFormatted?: string } }>(
    "/v0/quote",
    {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: q.assetId,
      depositType: "INTENTS",
      destinationAsset: q.assetId,
      amount: q.amountRaw,
      refundTo: q.account,
      refundType: "INTENTS",
      recipient: q.account,
      recipientType: "CONFIDENTIAL_INTENTS",
      deadline: new Date(Date.now() + (q.deadlineMs ?? 3_600_000)).toISOString(),
    },
    bearer(accessToken)
  );
  if (!j.quote?.depositAddress) throw new Error("1Click returned no deposit address for the shield quote");
  return { depositAddress: j.quote.depositAddress, deadline: j.quote.deadline ?? "", amountIn: j.quote.amountInFormatted ?? "", amountOut: j.quote.amountOutFormatted ?? "" };
}

/** The unsigned transfer intent that funds a confidential quote. Whoever holds the account's key (a DAO: the MPC signer) signs it. */
export async function generateIntent(accessToken: string, signerId: string, depositAddress: string): Promise<GeneratedIntent> {
  const j = await post<{ intent?: GeneratedIntent }>("/v0/generate-intent", { type: "swap_transfer", standard: "nep413", signerId, depositAddress }, bearer(accessToken));
  if (!j.intent?.payload) throw new Error("1Click returned no intent to sign");
  return j.intent;
}

/** What the signer signs for a generated intent: NEP-413's hash of its message, nonce and recipient. For a DAO this is the hash the `sign` proposal carries. */
export const intentHash = (intent: GeneratedIntent) => nep413Hash(intent.payload.message, Buffer.from(intent.payload.nonce, "base64"), intent.payload.recipient).toString("hex");

/** Hand the signed intent to 1Click, which runs the payout. Returns the intent's hash. */
export async function submitIntent(accessToken: string, intent: GeneratedIntent, publicKey: string, signature: string): Promise<string> {
  const { message, nonce, recipient, callbackUrl } = intent.payload;
  const signedData: Nep413SignedData = { standard: "nep413", payload: { message, nonce, recipient, ...(callbackUrl ? { callbackUrl } : {}) }, public_key: publicKey, signature };
  return (await post<{ intentHash: string }>("/v0/submit-intent", { type: "swap_transfer", signedData }, bearer(accessToken))).intentHash;
}

/**
 * Where a confidential payout is: PROCESSING, then SUCCESS, FAILED or REFUNDED. Asked with the account's login, because a
 * confidential deposit address is not visible without it. A payout from an account with no balance ends FAILED within seconds.
 */
export async function confidentialStatus(accessToken: string, depositAddress: string): Promise<{ status: string; refunded: string }> {
  const res = await fetch(`${CONFIDENTIAL_BASE}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: { ...partner(), ...bearer(accessToken) }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`1Click status failed (${res.status})`);
  const j = (await res.json()) as { status?: string; swapDetails?: { refundedAmountFormatted?: string } };
  return { status: String(j.status ?? "UNKNOWN"), refunded: j.swapDetails?.refundedAmountFormatted ?? "0" };
}

/** FastNEAR's transaction index: the way to find a council vote's transaction when the vote was cast from a wallet and this app never saw it. */
export const TX_INDEX = (process.env.FASTNEAR_TX_URL ?? (NETWORK === "testnet" ? "https://tx.test.fastnear.com" : "https://tx.main.fastnear.com")).replace(/\/$/, "");

interface IndexedTx {
  execution_outcome?: { outcome?: { status?: unknown } };
  receipts?: { execution_outcome?: { outcome?: { status?: unknown } } }[];
}

const txPost = async <T,>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${TX_INDEX}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The transaction index failed (${res.status})`);
  return (await res.json()) as T;
};

/**
 * The MPC signature for `hashHex`, found on the chain. A DAO's executing vote carries the signature in its outcome, but a council
 * member voting in a wallet does not tell this app which transaction that was, so the DAO's recent calls are read from the index and
 * the one whose signature verifies, for this hash under this DAO's key, is the answer. Undefined if none does (yet).
 */
export async function findMpcSignature(dao: string, hashHex: string, derivedKey?: string): Promise<string | undefined> {
  const key = derivedKey ?? (await daoDerivedKey(dao));
  const list = await txPost<{ account_txs?: { transaction_hash: string; is_receiver?: boolean; is_function_call?: boolean }[] }>("/v0/account", { account_id: dao, limit: 100 });
  const hashes = [...new Set((list.account_txs ?? []).filter((t) => t.is_receiver && t.is_function_call).map((t) => t.transaction_hash))];
  for (let i = 0; i < hashes.length; i += 10) {
    const { transactions = [] } = await txPost<{ transactions?: IndexedTx[] }>("/v0/transactions", { tx_hashes: hashes.slice(i, i + 10) });
    for (const tx of transactions) {
      const outcomes = [tx.execution_outcome, ...(tx.receipts ?? []).map((r) => r.execution_outcome)].filter(Boolean) as { outcome?: { status?: unknown } }[];
      const signature = mpcSignature({ receipts_outcome: outcomes.map((o) => ({ outcome: { status: o.outcome?.status } })) });
      if (signature && verifyMpcSignature(hashHex, signature, key)) return signature;
    }
  }
  return undefined;
}
