import type { Confidentiality, KybRecord, PassportRecord } from "./types";

/**
 * Tiered verification: the council decides, in the policy, who has to verify and when, so most payments ask nobody for anything.
 * A vendor is verified by Persona (documents, held by Persona) or, if the council accepts it, by a passport proof (Self: a real passport,
 * adult, not on OFAC lists, with no name or documents shared). Pure: lib/fraud.ts and lib/kyb.ts apply it.
 */
export interface VerificationTiers {
  /** A vendor must be verified for payments at or above this amount. Missing: no amount rule. 0: always. */
  verifyVendorsFromUsd?: number;
  /** A vendor never paid before must be verified, whatever the amount. */
  verifyNewVendors?: boolean;
  /** This business must be verified to release payments at or above this amount. Missing: no amount rule. */
  verifyBusinessFromUsd?: number;
  /** This business must be verified to make a confidential ("advanced") payment. */
  verifyForPrivacy?: boolean;
  /** A passport proof (Self) counts as verification. Missing means yes. */
  acceptPassportProof?: boolean;
}

/** Whether the policy sets any vendor rule; a policy from before tiers existed falls back to "unverified warns". */
export const hasVendorTiers = (t: VerificationTiers) => t.verifyVendorsFromUsd !== undefined || !!t.verifyNewVendors;

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/** How a party stands: verified by either route the council accepts, failed, in progress, or never started. */
export function standing(kyb: KybRecord | undefined, passport: PassportRecord | undefined, t: VerificationTiers): { state: "verified" | "declined" | "open" | "none"; how: string } {
  if (kyb?.status === "verified") return { state: "verified", how: "passed business verification (Persona)" };
  if (passport?.status === "verified" && t.acceptPassportProof !== false) return { state: "verified", how: "proved with a passport (Self): real holder, adult, not on OFAC lists" };
  if (kyb?.status === "declined" || passport?.status === "declined") return { state: "declined", how: "failed verification" };
  if (kyb) return { state: "open", how: `verification is ${kyb.status}` };
  if (passport?.status === "pending") return { state: "open", how: "passport check is pending" };
  return { state: "none", how: "not verified" };
}

/** Does this payment need the vendor verified, and why? */
export function vendorRequirement(amountUsd: number, paidBefore: boolean, t: VerificationTiers): { required: boolean; why: string } {
  if (t.verifyVendorsFromUsd !== undefined && amountUsd >= t.verifyVendorsFromUsd) {
    return { required: true, why: t.verifyVendorsFromUsd === 0 ? "the policy requires every vendor to be verified" : `the policy requires a verified vendor from ${usd(t.verifyVendorsFromUsd)}` };
  }
  if (t.verifyNewVendors && !paidBefore) return { required: true, why: "the policy requires a vendor to be verified before its first payment" };
  return { required: false, why: t.verifyVendorsFromUsd !== undefined ? `under ${usd(t.verifyVendorsFromUsd)}, the policy does not require it` : "the policy does not require it for this payment" };
}

/** Does this payment need this business itself verified, and why? `always` is the operator's KYB_REQUIRED switch. */
export function businessRequirement(amountUsd: number, confidentiality: Confidentiality, t: VerificationTiers, always = false): { required: boolean; why: string } {
  if (always) return { required: true, why: "this platform requires every business to be verified" };
  if (t.verifyBusinessFromUsd !== undefined && amountUsd >= t.verifyBusinessFromUsd) return { required: true, why: `the policy requires your business to be verified from ${usd(t.verifyBusinessFromUsd)}` };
  if (t.verifyForPrivacy && confidentiality === "advanced") return { required: true, why: "the policy requires your business to be verified for confidential payments" };
  return { required: false, why: "" };
}

/** The tier rules in plain words, for the Policy page and the DAO proposal text. */
export function describeTiers(t: VerificationTiers): string {
  const parts: string[] = [];
  if (t.verifyVendorsFromUsd !== undefined) parts.push(t.verifyVendorsFromUsd === 0 ? "every vendor verified" : `vendors verified from ${usd(t.verifyVendorsFromUsd)}`);
  if (t.verifyNewVendors) parts.push("new vendors verified");
  if (t.verifyBusinessFromUsd !== undefined) parts.push(`business verified from ${usd(t.verifyBusinessFromUsd)}`);
  if (t.verifyForPrivacy) parts.push("business verified for confidential payments");
  parts.push(t.acceptPassportProof === false ? "Persona only" : "passport proofs accepted");
  return parts.join(", ");
}
