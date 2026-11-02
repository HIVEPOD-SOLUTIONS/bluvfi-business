import { canonical, mlDsaPublicKey, mlDsaSign, mlDsaVerify, sha256, slhDsaPublicKey, slhDsaSign, slhDsaVerify } from "./crypto";
import { bitsPass, expectedBits, type ZkJob } from "./zk";

/**
 * The policy check, signed twice with post-quantum signatures: ML-DSA-65 (FIPS 204, lattice-based) and
 * SLH-DSA-SHA2-128f (FIPS 205, hash-based, resting on SHA-256 alone). Forging one needs a break of both families.
 *
 * Every input of the check is public (the same statement the o1js proof uses, lib/zk.ts), so a verifier needs no
 * zero-knowledge proof to know the result is right: it re-runs the check. The signatures add who vouched for that
 * result and that nothing changed afterwards. This is post-quantum where the o1js proof (elliptic curves) is not;
 * it is not zero-knowledge, which hides nothing here anyway.
 */
export interface PqPolicyCheck {
  /** sha256 of the canonical statement. */
  statementHash: string;
  outputBits: number;
  signedAt: string;
  mlDsa: { publicKey: string; signature: string };
  slhDsa: { publicKey: string; signature: string };
  /** Both signatures verified when signed. The payment page verifies again on every view. */
  valid: boolean;
}

export interface PqCheckResult {
  status: "verified" | "invalid";
  note: string;
}

/** What is signed: the payment, the exact statement and the check's output. Domain-separated from record signatures. */
export const pqMessage = (paymentId: string, statementHash: string, bits: number) =>
  `bluvfi-business:policy-check:v1:${paymentId}:${statementHash}:${bits}`;

export function signPolicyCheck(paymentId: string, job: ZkJob, seeds: { mlDsa: string; slhDsa: string }): PqPolicyCheck {
  const statementHash = sha256(canonical(job));
  const outputBits = expectedBits(job);
  const msg = pqMessage(paymentId, statementHash, outputBits);
  const mlDsa = mlDsaSign(msg, seeds.mlDsa);
  const slhDsa = slhDsaSign(msg, seeds.slhDsa);
  return {
    statementHash, outputBits, signedAt: new Date().toISOString(), mlDsa, slhDsa,
    valid: mlDsaVerify(mlDsa.signature, msg, mlDsa.publicKey) && slhDsaVerify(slhDsa.signature, msg, slhDsa.publicKey),
  };
}

/** This app's own public keys for the policy-check signatures, so a record signed by any other key is refused. */
export const appPqKeys = (seeds: { mlDsa: string; slhDsa: string }) => ({ mlDsa: mlDsaPublicKey(seeds.mlDsa), slhDsa: slhDsaPublicKey(seeds.slhDsa) });

/** Re-runs the check from the public statement, then verifies both signatures against the trusted keys. */
export function verifyPolicyCheck(paymentId: string, job: ZkJob, a: PqPolicyCheck, trusted: { mlDsa: string; slhDsa: string }): PqCheckResult {
  const bad = (note: string): PqCheckResult => ({ status: "invalid", note });
  const statementHash = sha256(canonical(job));
  if (statementHash !== a.statementHash) return bad("The signed statement is not this payment's statement.");
  const rerun = expectedBits(job);
  if (rerun !== a.outputBits) return bad(`Re-running the check gives ${rerun.toString(2)}, but ${a.outputBits.toString(2)} was signed.`);
  if (a.mlDsa.publicKey !== trusted.mlDsa || a.slhDsa.publicKey !== trusted.slhDsa) return bad("Signed by keys that are not this app's.");
  const msg = pqMessage(paymentId, statementHash, a.outputBits);
  const ml = mlDsaVerify(a.mlDsa.signature, msg, a.mlDsa.publicKey);
  const slh = slhDsaVerify(a.slhDsa.signature, msg, a.slhDsa.publicKey);
  if (!ml || !slh) return bad(`Signature check failed: ML-DSA-65 ${ml ? "valid" : "INVALID"}, SLH-DSA ${slh ? "valid" : "INVALID"}.`);
  return {
    status: "verified",
    note: `Re-ran the check from its public inputs (${bitsPass(rerun) ? "passes" : "fails"}) and verified both post-quantum signatures: ML-DSA-65 (lattice) and SLH-DSA-SHA2-128f (hash-based).`,
  };
}
