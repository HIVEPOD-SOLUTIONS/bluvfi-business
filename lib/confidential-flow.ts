import { cfg } from "./business";
import { ASSET_ID, NEAR_USDC_CONTRACT } from "./chains";
import {
  authenticate, confidentialQuote, confidentialStatus, daoDerivedKey, findMpcSignature, generateIntent, intentHash, prepareLogin, refreshTokens, shieldQuote, signProposal, submitIntent,
  type GeneratedIntent, type Tokens,
} from "./confidential";
import { addDaoProposal, trezuDescription, viewDao } from "./custody";
import { decrypt, encrypt } from "./crypto";
import { dataKey, state } from "./store";
import type { CustodyRecord, Invoice, Quote } from "./types";

/**
 * How a confidential treasury (a Sputnik DAO whose funds are shielded in Confidential Intents) pays and logs in. The DAO has no
 * key, so every signature comes from NEAR's MPC signer after a council vote on a proposal the agent files:
 *  1. Log in, about once a week: the council approves a proposal that signs a login message (it moves nothing). The tokens are kept
 *     encrypted, and the access token is refreshed on its own.
 *  2. Pay: a confidential quote, then the transfer intent that funds it. The agent files a proposal asking the MPC signer to sign that
 *     intent's hash; the proposal shows the council only a hash, not who is paid or how much.
 *  3. When the council approves, the signature is read from the vote, the intent is submitted to 1Click, and 1Click runs the payout.
 */
const enabled = () => {
  if (!cfg().CONFIDENTIAL) throw new Error("This treasury is not set up as a confidential treasury");
  return cfg().DAO_ACCOUNT;
};

const keep = (t: Tokens) => {
  const now = Date.now();
  const k = dataKey();
  const c = (state().confidential ??= {});
  c.access = encrypt(t.accessToken, k);
  c.refresh = encrypt(t.refreshToken, k);
  c.accessExp = now + t.expiresIn * 1000;
  c.refreshExp = now + t.refreshExpiresIn * 1000;
};

/** A valid access token for the treasury, refreshed from the refresh token. Throws, saying what to do, if the council has to log it in again. */
export async function confidentialSession(): Promise<string> {
  const c = state().confidential;
  const now = Date.now();
  if (c?.access && c.accessExp && c.accessExp - 30_000 > now) return decrypt(c.access, dataKey());
  if (c?.refresh && c.refreshExp && c.refreshExp - 30_000 > now) {
    const t = await refreshTokens(decrypt(c.refresh, dataKey()));
    keep(t);
    return t.accessToken;
  }
  throw new Error("The treasury is not logged in to Confidential Intents. An owner starts the login on the Overview and the council approves it; it lasts about a week.");
}

export interface LoginStatus {
  state: "off" | "logged_in" | "needs_login" | "waiting_for_council" | "waiting_for_signature";
  detail: string;
  proposalId?: number;
  loggedInUntil?: string;
}

/** Where the treasury's login stands, without calling anything but its own records. */
export function loginStatus(): LoginStatus {
  if (!cfg().CONFIDENTIAL) return { state: "off", detail: "This is not a confidential treasury." };
  const c = state().confidential;
  const now = Date.now();
  if (c?.access && c.refreshExp && c.refreshExp > now) return { state: "logged_in", detail: "Logged in to Confidential Intents.", loggedInUntil: new Date(c.refreshExp).toISOString() };
  if (c?.login) return { state: "waiting_for_council", detail: `The login is proposal #${c.login.proposalId} on the DAO: the council has to approve it.`, proposalId: c.login.proposalId };
  return { state: "needs_login", detail: "Not logged in. Start the login and have the council approve it." };
}

/** The agent files the DAO proposal that has the MPC signer sign a login message. The council's approval is the login. */
export async function startConfidentialLogin(): Promise<{ proposalId: number }> {
  const dao = enabled();
  const prep = await prepareLogin(dao);
  const description = trezuDescription({
    proposal_action: "custom",
    title: "Log the treasury in to Confidential Intents",
    notes: "Filed by the Bluvfi Business agent. Approving this has NEAR's MPC signer sign a login message for this DAO. The message moves nothing: it only lets Bluvfi Business read the treasury's shielded balance and request payouts, which each need their own approval. It lasts about a week.",
    hash_to_sign: prep.hashHex,
  });
  const proposalId = await addDaoProposal(signProposal(dao, prep.hashHex), description);
  (state().confidential ??= {}).login = { message: prep.message, nonce: prep.nonce, hashHex: prep.hashHex, proposalId, startedAt: new Date().toISOString() };
  return { proposalId };
}

/** After the council has voted: read the signature from the chain and log in. Safe to call any number of times. */
export async function finishConfidentialLogin(): Promise<LoginStatus> {
  const dao = enabled();
  const login = state().confidential?.login;
  if (!login) return loginStatus();
  const prop = await viewDao<{ status: string }>("get_proposal", { id: login.proposalId });
  if (prop.status === "InProgress") return { state: "waiting_for_council", detail: `Login proposal #${login.proposalId} is still open.`, proposalId: login.proposalId };
  if (prop.status !== "Approved") {
    delete state().confidential!.login;
    return { state: "needs_login", detail: `Login proposal #${login.proposalId} was ${prop.status.toLowerCase()}. Start it again.` };
  }
  const key = await daoDerivedKey(dao);
  const signature = await findMpcSignature(dao, login.hashHex, key);
  if (!signature) return { state: "waiting_for_signature", detail: `Login proposal #${login.proposalId} is approved; its signature is not on the chain index yet. Check again in a minute.`, proposalId: login.proposalId };
  keep(await authenticate({ standard: "nep413", payload: { message: login.message, nonce: login.nonce, recipient: "intents.near" }, public_key: key, signature }));
  delete state().confidential!.login;
  return loginStatus();
}

const raw = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();

/** A confidential quote for a payout: USDC from the shielded balance, paid out on the vendor's chain. */
export async function quoteConfidentialPayout(inv: Invoice, deadlineMs: number): Promise<Quote> {
  const dao = enabled();
  const destination = ASSET_ID[`${inv.chain}:${inv.asset}`];
  if (!destination) throw new Error(`No NEAR Intents route for ${inv.asset} on ${inv.chain}`);
  const q = await confidentialQuote(await confidentialSession(), { account: dao, originAsset: ASSET_ID["near:USDC"], destinationAsset: destination, amountOutRaw: raw(inv.amountUsd), recipient: inv.payoutAddress, deadlineMs });
  return { depositAddress: q.depositAddress, amountIn: q.amountIn, amountOut: q.amountOut, deadline: q.deadline, timeWhenInactive: q.deadline, source: "1click", confidential: true };
}

/** The intent that funds a confidential quote, and the hash the council's proposal asks the MPC signer to sign. */
export async function prepareIntent(depositAddress: string): Promise<{ intent: GeneratedIntent; hashHex: string }> {
  const intent = await generateIntent(await confidentialSession(), enabled(), depositAddress);
  return { intent, hashHex: intentHash(intent) };
}

/**
 * The council has approved the signing proposal: read the signature from the vote and hand the intent to 1Click. Throws if the
 * signature is not on the index yet (it is tried again on the next check). Safe to call again once submitted.
 */
export async function completeConfidentialPayout(rec: CustodyRecord): Promise<void> {
  const c = rec.confidential;
  if (!c || c.intentHash) return;
  const dao = enabled();
  const key = await daoDerivedKey(dao);
  const signature = await findMpcSignature(dao, c.hashHex, key);
  if (!signature) throw new Error("the council's signature is not on the chain index yet");
  c.intentHash = await submitIntent(await confidentialSession(), c.intent, key, signature);
  c.submittedAt = new Date().toISOString();
}

/** Where a confidential payout is: 1Click's status for its deposit address, read with the treasury's login. */
export async function confidentialPayoutStatus(depositAddress: string): Promise<string> {
  return (await confidentialStatus(await confidentialSession(), depositAddress)).status;
}

// ---------- Getting funds into the shielded balance ----------

export interface ShieldStatus {
  stage: "none" | "deposit" | "sign" | "submitted" | "done" | "failed";
  detail: string;
  amountUsd?: number;
}

export function shieldStatus(): ShieldStatus {
  const s = state().confidential?.shield;
  return s ? { stage: s.stage, detail: s.detail, amountUsd: Number(s.amountRaw) / 1e6 } : { stage: "none", detail: "Nothing is being shielded." };
}

/**
 * Step one of shielding `usd` of the DAO's USDC: a DAO proposal that deposits it into the public Intents balance (`ft_transfer_call` to
 * `intents.near`, an ordinary payment the council approves). The DAO's USDC leaves the treasury account but is still the DAO's.
 */
export async function startShield(usd: number): Promise<{ proposalId: number }> {
  const dao = enabled();
  if (!(usd > 0)) throw new Error("Give an amount above zero");
  const open = state().confidential?.shield;
  if (open && (open.stage === "deposit" || open.stage === "sign" || open.stage === "submitted")) throw new Error("A shield is already in progress. Finish it first.");
  const amountRaw = raw(usd);
  const kind = {
    FunctionCall: {
      receiver_id: NEAR_USDC_CONTRACT,
      actions: [{ method_name: "ft_transfer_call", args: Buffer.from(JSON.stringify({ receiver_id: "intents.near", amount: amountRaw, msg: JSON.stringify({ receiver_id: dao }) })).toString("base64"), deposit: "1", gas: "100000000000000" }],
    },
  };
  const description = trezuDescription({
    proposal_action: "custom",
    title: "Deposit USDC for shielding",
    notes: `Filed by the Bluvfi Business agent. Moves ${usd} USDC from this DAO into its own balance at Intents (intents.near). It stays the DAO's. A second proposal then shields it.`,
  });
  const proposalId = await addDaoProposal(kind, description);
  (state().confidential ??= {}).shield = { stage: "deposit", amountRaw, depositProposalId: proposalId, detail: `Deposit proposal #${proposalId} is waiting for the council.` };
  return { proposalId };
}

const proposalStatus = async (id: number) => (await viewDao<{ status: string }>("get_proposal", { id })).status;
const fail = (s: NonNullable<NonNullable<ReturnType<typeof state>["confidential"]>["shield"]>, why: string): ShieldStatus => {
  s.stage = "failed";
  s.detail = why;
  return shieldStatus();
};

/** Move the shield along as far as it can go: safe to call as often as you like. */
export async function advanceShield(): Promise<ShieldStatus> {
  const dao = enabled();
  const s = state().confidential?.shield;
  if (!s || s.stage === "done" || s.stage === "failed") return shieldStatus();

  if (s.stage === "deposit") {
    const status = await proposalStatus(s.depositProposalId);
    if (status === "InProgress") return shieldStatus();
    if (status !== "Approved") return fail(s, `Deposit proposal #${s.depositProposalId} was ${status.toLowerCase()}. Nothing moved.`);
    // Deposited. Ask 1Click how to shield it, and have the council sign that.
    const token = await confidentialSession();
    const q = await shieldQuote(token, { account: dao, assetId: ASSET_ID["near:USDC"], amountRaw: s.amountRaw });
    const intent = await generateIntent(token, dao, q.depositAddress);
    const hashHex = intentHash(intent);
    const description = trezuDescription({
      proposal_action: "custom",
      title: "Shield the deposited USDC",
      notes: "Filed by the Bluvfi Business agent. Approving this has NEAR's MPC signer sign the transfer that moves the deposited USDC into this DAO's shielded balance. Nothing leaves the DAO.",
      hash_to_sign: hashHex,
    });
    s.signProposalId = await addDaoProposal(signProposal(dao, hashHex), description);
    Object.assign(s, { stage: "sign", intent, hashHex, depositAddress: q.depositAddress, detail: `Shield proposal #${s.signProposalId} is waiting for the council.` });
    return shieldStatus();
  }

  if (s.stage === "sign") {
    const status = await proposalStatus(s.signProposalId!);
    if (status === "InProgress") return shieldStatus();
    if (status !== "Approved") return fail(s, `Shield proposal #${s.signProposalId} was ${status.toLowerCase()}. The USDC is in the DAO's Intents balance; start the shield again.`);
    const key = await daoDerivedKey(dao);
    const signature = await findMpcSignature(dao, s.hashHex!, key);
    if (!signature) {
      s.detail = `Shield proposal #${s.signProposalId} is approved; collecting the signature from the chain index. Check again in a minute.`;
      return shieldStatus();
    }
    s.intentHash = await submitIntent(await confidentialSession(), s.intent!, key, signature);
    Object.assign(s, { stage: "submitted", detail: `Submitted to 1Click (intent ${s.intentHash}). Waiting for it to complete.` });
    return shieldStatus();
  }

  const done = await confidentialPayoutStatus(s.depositAddress!);
  if (done === "SUCCESS") Object.assign(s, { stage: "done", detail: "Shielded. The balance is now confidential." });
  else if (done === "FAILED" || done === "REFUNDED") return fail(s, `1Click ended the shield as ${done}. The USDC is still in the DAO's Intents balance; start the shield again.`);
  return shieldStatus();
}
