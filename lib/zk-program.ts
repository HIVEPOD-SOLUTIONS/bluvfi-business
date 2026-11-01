import { Bool, Field, Provable, Struct, UInt64, ZkProgram } from "o1js";

/**
 * The policy gate of lib/policy.ts as an o1js zero-knowledge program, in TypeScript. Every field of the
 * statement is public, so a proof says: "for this payment (`subject`) under this policy (`policyHash`), with
 * these amounts, limits and lists, the policy check outputs these bits." Proofs are made and checked in Node.
 *
 * Output bits (1 = passes):
 *   0 kill switch is off        1 within the per-payment limit   2 within the daily limit
 *   3 chain is permitted        4 asset is permitted              5 vendor is on the allowlist
 *   6 at or over the approval threshold (needs a signer; not a failure)
 * The gate passes when bits 0-4 are all set; bit 5 unset is a warning, as in the app.
 *
 * Only lib/zk.ts imports this file, lazily: o1js is large and only needed when proving or verifying.
 */
export const MAX_ALLOWLIST = 16;

export class PolicyStatement extends Struct({
  subject: Field,
  policyHash: Field,
  amountCents: UInt64,
  perPaymentLimitCents: UInt64,
  dailyLimitCents: UInt64,
  spentTodayCents: UInt64,
  approvalThresholdCents: UInt64,
  killSwitch: Bool,
  chainCode: Field,
  allowedChainsMask: Field,
  assetCode: Field,
  allowedAssetsMask: Field,
  vendor: Field,
  /** Allowlisted vendor hashes, padded with 0 (never a real hash). */
  allowlist: Provable.Array(Field, MAX_ALLOWLIST),
}) {}

/** Is bit `code` set in a 32-bit mask? */
function inMask(code: Field, mask: Field): Bool {
  const bits = mask.toBits(32);
  let hit = Bool(false);
  for (let i = 0; i < 32; i++) hit = hit.or(code.equals(i).and(bits[i]));
  return hit;
}

const bit = (cond: Bool, n: number) => Provable.if(cond, Field(1 << n), Field(0));

export const PolicyCheck = ZkProgram({
  name: "bluvfi-policy-check",
  publicInput: PolicyStatement,
  publicOutput: Field,
  methods: {
    check: {
      privateInputs: [],
      async method(s: PolicyStatement) {
        let listed = Bool(false);
        for (const entry of s.allowlist) listed = listed.or(entry.equals(s.vendor).and(entry.equals(0).not()));
        const bits = bit(s.killSwitch.not(), 0)
          .add(bit(s.amountCents.lessThanOrEqual(s.perPaymentLimitCents), 1))
          .add(bit(s.spentTodayCents.add(s.amountCents).lessThanOrEqual(s.dailyLimitCents), 2))
          .add(bit(inMask(s.chainCode, s.allowedChainsMask), 3))
          .add(bit(inMask(s.assetCode, s.allowedAssetsMask), 4))
          .add(bit(listed, 5))
          .add(bit(s.amountCents.greaterThanOrEqual(s.approvalThresholdCents), 6));
        return { publicOutput: bits };
      },
    },
  },
});

/** o1js is loaded once, from here: lib/zk.ts uses these instead of importing o1js itself. */
export { Bool, Cache, Field, UInt64, verify } from "o1js";
