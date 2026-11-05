import type { Confidentiality } from "./types";

/**
 * Who needs privacy, as rules the council sets and the policy hash covers (the AI decides none of it):
 *  - a profile that says what kind of treasury this is, and fills in sensible rules for it;
 *  - a floor every payment must meet;
 *  - tiers: payments at or above an amount are raised to a level;
 *  - vendors named as needing it (payroll, investors, legal): their payments are raised to a level.
 * A payment goes out at the highest level any rule asks for. Pure functions only, so the policy page can use them too.
 */
export type PrivacyProfile = "open" | "startup" | "institution" | "holder";
export interface PrivacyRules {
  privacyFloor?: Confidentiality;
  privacyTiers?: { aboveUsd: number; level: Confidentiality }[];
  privateVendors?: Record<string, Confidentiality>;
}

export const RANK: Record<Confidentiality, number> = { public: 0, basic: 1, advanced: 2 };
export const LEVELS: Confidentiality[] = ["public", "basic", "advanced"];

export const PRIVACY_PROFILES: Record<PrivacyProfile, { label: string; who: string; floor: Confidentiality; tiers: { aboveUsd: number; level: Confidentiality }[] }> = {
  open: { label: "Open (DAO, public goods)", who: "Spending is meant to be seen. Nothing is raised unless a vendor is named below.", floor: "public", tiers: [] },
  startup: { label: "Startup", who: "Open by default. Larger payments go private (basic from $5,000), and so do the vendors you name: payroll, contractors, investors, legal.", floor: "public", tiers: [{ aboveUsd: 5_000, level: "basic" }] },
  institution: { label: "Organisation or institution", who: "Private by default (basic at least), and fully confidential from $25,000.", floor: "basic", tiers: [{ aboveUsd: 25_000, level: "advanced" }] },
  holder: { label: "Investor or holder (store of value)", who: "Every payment fully confidential: the balance and the payees stay private.", floor: "advanced", tiers: [] },
};

/** What a payment actually gets: the highest of what was asked and what every rule requires, with the reasons. */
export function privacyFor(asked: Confidentiality, rules: PrivacyRules, vendorName: string, amountUsd: number): { level: Confidentiality; why: string[] } {
  const wants: { level: Confidentiality; why: string }[] = [];
  const floor = rules.privacyFloor ?? "public";
  if (RANK[floor] > 0) wants.push({ level: floor, why: `the privacy floor is ${floor}` });
  for (const t of rules.privacyTiers ?? []) if (amountUsd >= t.aboveUsd && RANK[t.level] > 0) wants.push({ level: t.level, why: `payments of $${t.aboveUsd.toLocaleString()} or more are ${t.level}` });
  const vendor = rules.privateVendors?.[vendorName];
  if (vendor && RANK[vendor] > 0) wants.push({ level: vendor, why: `${vendorName} is named as needing ${vendor} privacy` });
  const level = [asked, ...wants.map((w) => w.level)].reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return { level, why: RANK[level] > RANK[asked] ? wants.filter((w) => w.level === level).map((w) => w.why) : [] };
}
