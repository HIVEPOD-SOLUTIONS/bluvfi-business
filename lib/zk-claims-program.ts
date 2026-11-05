import { Bool, Field, MerkleWitness, Poseidon, Provable, PublicKey, Signature, SelfProof, Struct, UInt64, ZkProgram } from "o1js";

/**
 * Zero-knowledge claims, each keeping something secret that an ordinary proof of a policy check does not. Written in o1js, like
 * lib/zk-program.ts. In each, the verifier gets a yes about a statement and learns nothing else about the secret.
 *
 *  1. SanctionsClearance: "this payee address is not on the OFAC list whose root is R", without saying who the payee is.
 *  2. NameClearance: "this exact (normalised) vendor name is not on the OFAC list whose root is R", without saying the name.
 *  3. VerifiedCredential: "a party that passed identity verification, attested by k of these issuers, is behind this commitment".
 *  4. Solvency: "the treasury held at least $X, attested by k of these issuers", without showing any balance or account.
 *  5. CircuitChunks + CircuitResources: "a secret circuit of any length uses at most Q qubits and T Toffoli gates", proved a chunk at a time
 *     by recursion, so the circuit is not limited to one proof's size.
 *
 * A claim is only as good as what it is anchored to: (1) and (2) to a public list root anyone can recompute from OFAC's list, (3) and (4) to
 * signatures from independent issuers (several must agree), and (5) to a commitment the prover is bound to. Only lib/zk-claims.ts imports
 * this file, lazily.
 */

// ---------- 1 and 2. Clearance: not in a sorted list ----------
/** A tree of height H has 2^(H-1) leaves. */
export const TREE_HEIGHT = 12; // 2048 gaps: room for 2047 listed addresses (OFAC lists about 550 today)
export const NAME_TREE_HEIGHT = 17; // 65536 gaps: room for 65535 listed names and aliases (OFAC lists about 35,000 today)
export class ListWitness extends MerkleWitness(TREE_HEIGHT) {}
export class NameWitness extends MerkleWitness(NAME_TREE_HEIGHT) {}

/**
 * The list is a sorted set of hashes. Each leaf of the tree is one *gap* between two neighbours, hash(lo, hi). An item that sits strictly
 * inside a gap whose leaf is in the tree is not in the set. The ends use 0 and 2^248 as sentinels.
 */
export class ClearanceStatement extends Struct({ listRoot: Field, subject: Field, itemCommitment: Field }) {}

export const SanctionsClearance = ZkProgram({
  name: "bluvfi-sanctions-clearance",
  publicInput: ClearanceStatement,
  publicOutput: Field,
  methods: {
    clear: {
      privateInputs: [Field, Field, Field, Field, ListWitness],
      async method(s: ClearanceStatement, item: Field, salt: Field, lo: Field, hi: Field, witness: ListWitness) {
        Poseidon.hash([item, salt]).assertEquals(s.itemCommitment);
        lo.assertLessThan(item);
        item.assertLessThan(hi);
        witness.calculateRoot(Poseidon.hash([lo, hi])).assertEquals(s.listRoot);
        return { publicOutput: Field(1) };
      },
    },
  },
});

export const NameClearance = ZkProgram({
  name: "bluvfi-name-clearance",
  publicInput: ClearanceStatement,
  publicOutput: Field,
  methods: {
    clear: {
      privateInputs: [Field, Field, Field, Field, NameWitness],
      async method(s: ClearanceStatement, item: Field, salt: Field, lo: Field, hi: Field, witness: NameWitness) {
        Poseidon.hash([item, salt]).assertEquals(s.itemCommitment);
        lo.assertLessThan(item);
        item.assertLessThan(hi);
        witness.calculateRoot(Poseidon.hash([lo, hi])).assertEquals(s.listRoot);
        return { publicOutput: Field(1) };
      },
    },
  },
});

// ---------- Attested by k of n issuers ----------
export const N_ISSUERS = 3;
/**
 * How many *different* issuers signed the message validly. A key that appears twice is counted once, so a single issuer listed in every slot
 * (the default, with no other attesters) counts as one, and two copies of one key cannot pass for two issuers.
 */
function distinctValidSignatures(issuers: PublicKey[], signatures: Signature[], message: Field[]): Field {
  let n = Field(0);
  for (let i = 0; i < N_ISSUERS; i++) {
    let firstTime = Bool(true);
    for (let j = 0; j < i; j++) firstTime = firstTime.and(issuers[i].equals(issuers[j]).not());
    n = n.add(signatures[i].verify(issuers[i], message).and(firstTime).toField());
  }
  return n;
}

// ---------- 3. Verified credential ----------
export const KIND_VENDOR = 1;
export const KIND_BUSINESS = 2;
export class CredentialStatement extends Struct({
  issuers: Provable.Array(PublicKey, N_ISSUERS),
  threshold: Field,
  subject: Field,
  kind: Field,
  subjectCommitment: Field,
  asOf: UInt64,
}) {}

export const VerifiedCredential = ZkProgram({
  name: "bluvfi-verified-credential-v2",
  publicInput: CredentialStatement,
  publicOutput: Field,
  methods: {
    prove: {
      privateInputs: [Field, Field, UInt64, Provable.Array(Signature, N_ISSUERS)],
      async method(s: CredentialStatement, subjectId: Field, salt: Field, validUntil: UInt64, signatures: Signature[]) {
        Poseidon.hash([subjectId, salt]).assertEquals(s.subjectCommitment);
        s.threshold.assertGreaterThanOrEqual(1);
        distinctValidSignatures(s.issuers, signatures, [s.kind, subjectId, validUntil.value]).assertGreaterThanOrEqual(s.threshold);
        s.asOf.value.assertLessThanOrEqual(validUntil.value);
        return { publicOutput: Field(1) };
      },
    },
  },
});

// ---------- 4. Solvency ----------
export const MAX_ACCOUNTS = 8;
export class SolvencyStatement extends Struct({
  issuers: Provable.Array(PublicKey, N_ISSUERS),
  threshold: Field,
  subject: Field,
  snapshotCommitment: Field,
  minTotalCents: UInt64,
  asOf: UInt64,
  maxAgeSeconds: UInt64,
}) {}

export const Solvency = ZkProgram({
  name: "bluvfi-solvency-v2",
  publicInput: SolvencyStatement,
  publicOutput: Field,
  methods: {
    prove: {
      privateInputs: [Provable.Array(UInt64, MAX_ACCOUNTS), Field, UInt64, Provable.Array(Signature, N_ISSUERS)],
      async method(s: SolvencyStatement, balances: UInt64[], salt: Field, takenAt: UInt64, signatures: Signature[]) {
        const commitment = Poseidon.hash([...balances.map((b) => b.value), salt, takenAt.value]);
        commitment.assertEquals(s.snapshotCommitment);
        s.threshold.assertGreaterThanOrEqual(1);
        distinctValidSignatures(s.issuers, signatures, [commitment, takenAt.value]).assertGreaterThanOrEqual(s.threshold);
        let sum = Field(0);
        for (const b of balances) sum = sum.add(b.value);
        s.minTotalCents.value.assertLessThanOrEqual(sum);
        takenAt.value.assertLessThanOrEqual(s.asOf.value);
        s.asOf.value.assertLessThanOrEqual(takenAt.value.add(s.maxAgeSeconds.value));
        return { publicOutput: Field(1) };
      },
    },
  },
});

// ---------- 5. Resources of a secret circuit, any length, by recursion ----------
/** Gates per proof. A longer circuit is proved a chunk at a time, each proof verifying the one before. */
export const CHUNK_GATES = 32;
/** Gate kinds: 0 padding, 1 one-qubit gate (a), 2 two-qubit gate (a, b), 3 Toffoli (a, b, c). */
export class Gate extends Struct({ kind: Field, a: Field, b: Field, c: Field }) {}
export class ResourceStatement extends Struct({ circuitCommitment: Field, subject: Field, maxQubits: Field, maxToffoli: Field }) {}
/** Where the walk through the circuit has got to: the hash chain so far, the Toffoli count, and the highest qubit used. */
export class ChunkState extends Struct({ h: Field, toffoli: Field, top: Field, any: Bool }) {}

const MAX_QUBIT_INDEX = 1 << 16;

/** Walk one chunk of gates from a state, checking every gate is valid, and return the new state. */
function absorb(from: ChunkState, gates: Gate[]): ChunkState {
  let { h, toffoli, top, any } = from;
  for (const g of gates) {
    // The commitment fixes the circuit: it is a hash chain over every gate, in order.
    h = Poseidon.hash([h, g.kind, g.a, g.b, g.c]);
    g.kind.mul(g.kind.sub(1)).mul(g.kind.sub(2)).mul(g.kind.sub(3)).assertEquals(0); // kind is 0, 1, 2 or 3
    const k1 = g.kind.equals(1), k2 = g.kind.equals(2), k3 = g.kind.equals(3);
    // A padding gate carries no qubits; a real gate's qubits are small, and a gate never uses one qubit twice.
    for (const [q, used] of [[g.a, k1.or(k2).or(k3)], [g.b, k2.or(k3)], [g.c, k3]] as [Field, Bool][]) {
      q.assertLessThan(MAX_QUBIT_INDEX);
      Provable.if(used, Field(0), q).assertEquals(0);
      top = Provable.if(used.and(q.greaterThan(top)), q, top);
      any = any.or(used);
    }
    k2.or(k3).and(g.a.equals(g.b)).assertFalse("a gate cannot use one qubit twice");
    k3.and(g.a.equals(g.c).or(g.b.equals(g.c))).assertFalse("a gate cannot use one qubit twice");
    toffoli = toffoli.add(Provable.if(k3, Field(1), Field(0)));
  }
  return new ChunkState({ h, toffoli, top, any });
}

/** The first chunk starts the chain at the salt; each later one verifies the proof before it and carries on from where it ended. */
export const CircuitChunks = ZkProgram({
  name: "bluvfi-circuit-chunks",
  publicInput: Field, // the subject
  publicOutput: ChunkState,
  methods: {
    start: {
      privateInputs: [Provable.Array(Gate, CHUNK_GATES), Field],
      async method(_subject: Field, gates: Gate[], salt: Field) {
        return { publicOutput: absorb(new ChunkState({ h: salt, toffoli: Field(0), top: Field(0), any: Bool(false) }), gates) };
      },
    },
    extend: {
      privateInputs: [SelfProof, Provable.Array(Gate, CHUNK_GATES)],
      async method(subject: Field, prev: SelfProof<Field, ChunkState>, gates: Gate[]) {
        prev.verify();
        prev.publicInput.assertEquals(subject);
        return { publicOutput: absorb(prev.publicOutput, gates) };
      },
    },
  },
});
export class ChunkProof extends ZkProgram.Proof(CircuitChunks) {}

/** The last step hides the exact counts: it checks the committed circuit stays within the bounds, and says only yes. */
export const CircuitResources = ZkProgram({
  name: "bluvfi-circuit-resources-v2",
  publicInput: ResourceStatement,
  publicOutput: Field,
  methods: {
    bound: {
      privateInputs: [ChunkProof],
      async method(s: ResourceStatement, prev: ChunkProof) {
        prev.verify();
        prev.publicInput.assertEquals(s.subject);
        const st = prev.publicOutput;
        st.h.assertEquals(s.circuitCommitment);
        const qubits = Provable.if(st.any, st.top.add(1), Field(0));
        qubits.assertLessThanOrEqual(s.maxQubits);
        st.toffoli.assertLessThanOrEqual(s.maxToffoli);
        return { publicOutput: Field(1) };
      },
    },
  },
});

/** o1js is loaded once, from here. */
export { Bool, Cache, Field, MerkleTree, Poseidon, PrivateKey, PublicKey, Scalar, Signature, UInt64, verify } from "o1js";
