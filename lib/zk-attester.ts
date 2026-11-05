import { createHash } from "node:crypto";
import { accountBalances } from "./chain";
import { deriveKey } from "./crypto";
import { fetchInquiry } from "./kyb";

/**
 * An independent attester. The app signs the facts it vouches for, but one signer is one point of trust. An attester is a separate service,
 * run by someone else (an auditor, a partner, another team member's machine), with its own key and its own access to the sources:
 * it checks the fact itself and signs only what it finds true. A credential or balance proof can then require that k different
 * issuers signed, so no single key, including the app's, can fake one.
 *
 *  - A balance: it reads the account's balance from the NEAR chain itself and refuses to sign a figure above what it sees.
 *  - A credential: it asks Persona (with its own key) whether the inquiry is approved, and that the inquiry is for the very business and
 *    vendor named, before signing.
 * It sees what it signs, so it is for parties that are allowed to know. Run it with `npm run zk:attester`.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hex31 = (hex: string) => BigInt(`0x${hex.slice(0, 62)}`);
const zk = () => import("./zk-claims-program");

export async function attesterKey(secretHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) throw new Error("ATTESTER_KEY must be 64 hex characters");
  const { PrivateKey, Scalar } = await zk();
  return PrivateKey.fromBigInt(BigInt(`0x${deriveKey(secretHex, "zk-attester")}`) % Scalar.ORDER);
}

export interface AttesterSources {
  readBalances: (account: string) => Promise<{ usd: boolean; amount: number }[]>;
  inquiry: (id: string) => Promise<{ status: string; note: string }>;
  now: () => number;
}
export const realSources: AttesterSources = { readBalances: accountBalances, inquiry: fetchInquiry, now: () => Date.now() };

export interface AttestRequest {
  kind?: "solvency" | "vendor" | "business";
  // solvency
  account?: string; balances?: number[]; salt?: string; takenAt?: number; commitment?: string;
  // credentials
  biz?: string; vendor?: string; inquiryId?: string; subjectId?: string; validUntil?: number;
}

const MAX_SKEW_SECONDS = 300;
const MAX_CREDENTIAL_DAYS = 31;

/** Check a fact and sign it, or throw why not. Returns the attester's public key and its signature (base58). */
export async function attest(req: AttestRequest, secretHex: string, src: AttesterSources = realSources): Promise<{ publicKey: string; signature: string }> {
  const z = await zk();
  const key = await attesterKey(secretHex);
  const F = z.Field, U = z.UInt64;
  const nowS = Math.floor(src.now() / 1000);
  let message: unknown[];

  if (req.kind === "solvency") {
    if (!req.account || !Array.isArray(req.balances) || req.balances.length !== z.MAX_ACCOUNTS || !req.salt || typeof req.takenAt !== "number" || !req.commitment) throw new Error("Incomplete balance request");
    if (!req.balances.every((c) => Number.isInteger(c) && c >= 0)) throw new Error("Balances must be whole cents");
    if (Math.abs(nowS - req.takenAt) > MAX_SKEW_SECONDS) throw new Error("The snapshot is not from now");
    const commitment = z.Poseidon.hash([...req.balances.map((c) => U.from(c).value), F(req.salt), U.from(req.takenAt).value]);
    if (commitment.toString() !== req.commitment) throw new Error("The commitment does not match the balances");
    // The attester reads the chain itself. It never signs a figure above what it sees, so a prover cannot overstate.
    const own = (await src.readBalances(req.account)).filter((b) => b.usd).reduce((n, b) => n + Math.round(b.amount * 100), 0);
    const claimed = req.balances.reduce((n, c) => n + c, 0);
    if (claimed > own) throw new Error(`The snapshot says ${claimed} cents but the chain shows ${own}`);
    message = [commitment, U.from(req.takenAt).value];
  } else if (req.kind === "vendor" || req.kind === "business") {
    if (!req.biz || !req.inquiryId || !req.subjectId || typeof req.validUntil !== "number") throw new Error("Incomplete credential request");
    if (req.kind === "vendor" && !req.vendor) throw new Error("Name the vendor");
    if (req.validUntil < nowS || req.validUntil > nowS + MAX_CREDENTIAL_DAYS * 86_400) throw new Error("The credential's expiry is out of range");
    // The subject the app proposes must be the one for this business and vendor, and the inquiry must be that party's, and approved.
    const expectSubject = hex31(sha(`${req.kind}:${req.biz}:${req.vendor ?? ""}`)).toString();
    if (req.subjectId !== expectSubject) throw new Error("The subject does not match this business and vendor");
    const inq = await src.inquiry(req.inquiryId);
    if (inq.status !== "approved") throw new Error(`Persona says the verification is ${inq.status}, not approved`);
    const expectNote = req.kind === "vendor" ? `bluvfi:${req.biz}:vendor:${req.vendor}`.slice(0, 200) : `bluvfi:${req.biz}:business`;
    if (inq.note !== expectNote) throw new Error("That verification was not made for this business and vendor");
    message = [F(req.kind === "vendor" ? z.KIND_VENDOR : z.KIND_BUSINESS), F(req.subjectId), U.from(req.validUntil).value];
  } else {
    throw new Error("Unknown kind of fact");
  }
  return { publicKey: key.toPublicKey().toBase58(), signature: z.Signature.create(key, message as never).toBase58() };
}
