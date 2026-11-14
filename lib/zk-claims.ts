import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cfg, getBusiness } from "./business";
import { MASTER_KEY } from "./config";
import { deriveKey } from "./crypto";
import type { SanctionsIndex } from "./sanctions";
import { addressKey, loadSanctions } from "./sanctions";
import { services } from "./services";
import { state } from "./store";
import { currentBiz } from "./tenant";
import { openText, sealText } from "./vault";
import { ZK_DIR } from "./zk";

/**
 * Zero-knowledge claims (lib/zk-claims-program.ts): a proof that says one true thing and keeps the rest secret. This file builds what each
 * proof needs, proves it, and verifies it. Each claim's private data (the payee, the balances, the circuit) is prepared inside the app,
 * handed to a separate prover process in a sealed file, and deleted as soon as the proof exists. A proof file holds only public statements.
 */
export type ClaimKind = "sanctions" | "name" | "vendor" | "business" | "solvency" | "circuit";
export const CLAIM_KINDS: ClaimKind[] = ["sanctions", "name", "vendor", "business", "solvency", "circuit"];
export const SYSTEM = "o1js (Kimchi proof system)";
export const CLAIMS_VK_FILE = join(process.cwd(), "zk", "claims-verification-keys.json");
const DIR = join(ZK_DIR, "claims");
const CREDENTIAL_DAYS = 30;
const SNAPSHOT_MAX_AGE_SECONDS = 24 * 3600;
/** The longest circuit one claim covers: 64 chunks of 32 gates, each its own recursive proof (about a quarter of a minute each). */
export const MAX_TOTAL_GATES = 2048;

const zk = () => import("./zk-claims-program");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hex31 = (hex: string) => BigInt(`0x${hex.slice(0, 62)}`);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomField = () => BigInt(`0x${randomBytes(31).toString("hex")}`).toString();

/** The program a kind of claim is verified with. */
const programOf = async (kind: ClaimKind) => {
  const z = await zk();
  return kind === "sanctions" ? z.SanctionsClearance : kind === "name" ? z.NameClearance : kind === "vendor" || kind === "business" ? z.VerifiedCredential : kind === "solvency" ? z.Solvency : z.CircuitResources;
};
const vkName = (kind: ClaimKind) => (kind === "business" ? "vendor" : kind); // one credential program serves both

const compiled = new Map<string, Promise<{ data: string; hash: string }>>();
/** Compile the program behind a kind of claim (the prover keys are cached in the zk cache folder). The circuit claim needs its chunk program first. */
export function compileClaim(kind: ClaimKind) {
  const name = vkName(kind);
  if (!compiled.has(name)) {
    compiled.set(name, (async () => {
      const z = await zk();
      mkdirSync(join(ZK_DIR, "cache"), { recursive: true });
      const cache = z.Cache.FileSystem(join(ZK_DIR, "cache"));
      if (kind === "circuit") await z.CircuitChunks.compile({ cache });
      const { verificationKey } = await (await programOf(kind)).compile({ cache });
      return { data: verificationKey.data, hash: verificationKey.hash.toString() };
    })());
  }
  return compiled.get(name)!;
}

// ---------- The issuers: keys that sign facts they have checked ----------
/** The app's own issuer key, derived from BLUVFI_MASTER_KEY; only its public half is ever shown. */
export async function issuerKey() {
  if (!/^[0-9a-f]{64}$/i.test(MASTER_KEY)) throw new Error("BLUVFI_MASTER_KEY is not set (64 hex characters)");
  const { PrivateKey, Scalar } = await zk(); // one copy of o1js: keys made elsewhere do not mix with its signatures
  return PrivateKey.fromBigInt(BigInt(`0x${deriveKey(MASTER_KEY, "zk-claims-issuer")}`) % Scalar.ORDER);
}
export const issuerPublicKey = async () => (await issuerKey()).toPublicKey().toBase58();

/**
 * Independent attesters (lib/zk-attester.ts, run by someone else): ZK_ATTESTERS="url|token|publicKey;url|token|publicKey" (at most two).
 * ZK_ATTEST_THRESHOLD is how many different issuers, this app included, must sign before a credential or balance proof can be made.
 */
export interface AttesterConfig { url: string; token: string; publicKey: string }
export const attesters = (): AttesterConfig[] =>
  (process.env.ZK_ATTESTERS ?? "").split(";").map((s) => s.trim()).filter(Boolean).slice(0, 2).map((s) => {
    const [url, token, publicKey] = s.split("|");
    if (!url || !token || !publicKey) throw new Error("ZK_ATTESTERS entries look like url|token|publicKey");
    return { url: url.replace(/\/$/, ""), token, publicKey };
  });
export const attestThreshold = () => Math.max(1, Math.min(3, Number(process.env.ZK_ATTEST_THRESHOLD ?? 1) || 1));

/** One attester's answer: its signature, or why it did not sign (shown in the error, so an operator can see the cause). */
async function ask(a: AttesterConfig, request: object): Promise<{ signature?: string; why?: string }> {
  try {
    const r = await fetch(`${a.url}/attest`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(60_000) });
    const j = (await r.json().catch(() => ({}))) as { publicKey?: string; signature?: string; error?: string };
    if (!r.ok) return { why: `HTTP ${r.status}${j.error ? `: ${String(j.error).slice(0, 200)}` : ""}` };
    if (j.publicKey !== a.publicKey) return { why: "it answered with a different key than the one configured" };
    return j.signature ? { signature: j.signature } : { why: "it returned no signature" };
  } catch (e) {
    return { why: (e as Error).message.slice(0, 200) };
  }
}

/**
 * Sign a fact with this app's key and ask every configured attester to check it and sign too. The proof will show all the issuer keys and
 * the threshold; it needs that many different keys to have signed. An attester that is down or refuses just does not count.
 */
async function attested(message: unknown[], request: object): Promise<{ issuers: string[]; signatures: string[]; threshold: number }> {
  const { Signature } = await zk();
  const key = await issuerKey();
  const mine = Signature.create(key, message as never).toBase58();
  const configured = attesters();
  const answers = await Promise.all(configured.map((a) => ask(a, request)));
  const theirs = answers.map((x) => x.signature);
  const own = key.toPublicKey().toBase58();
  const issuers = [own, ...configured.map((a) => a.publicKey)];
  const signatures = [mine, ...theirs.map((s) => s ?? mine)]; // a missing signature is a wrong one for that slot: it will not count
  while (issuers.length < 3) { issuers.push(own); signatures.push(mine); }
  const threshold = attestThreshold();
  const signed = 1 + theirs.filter(Boolean).length;
  if (signed < threshold) throw new Error(`${threshold} issuers must sign but only ${signed} did: ${configured.map((a, i) => `${a.url} ${theirs[i] ? "signed" : `did not (${answers[i].why})`}`).join(", ") || "no attesters are configured (ZK_ATTESTERS)"}`);
  return { issuers, signatures, threshold };
}

// ---------- 1 and 2. Clearance: the list as a Merkle tree of gaps ----------
const TOP = BigInt(1) << BigInt(248);
export const addressLeaf = (address: string) => hex31(sha(`addr:${addressKey(address)}`));
/** A name's leaf: the normalised name (lib/sanctions.ts normalizeName), hashed. Only an exact match of that normalised form is covered. */
export const nameLeaf = (normalised: string) => hex31(sha(`name:${normalised}`));

const sortedUnique = (xs: bigint[]) => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const gapsOf = (sorted: bigint[]): [bigint, bigint][] => {
  const edges = [BigInt(0), ...sorted, TOP];
  return edges.slice(0, -1).map((lo, i) => [lo, edges[i + 1]] as [bigint, bigint]);
};

/** Every listed address as a sorted hash, and the gaps between neighbours (with 0 and 2^248 as ends). */
export function listGaps(idx: SanctionsIndex): { sorted: bigint[]; gaps: [bigint, bigint][] } {
  const sorted = sortedUnique(Object.keys(idx.addresses).map(addressLeaf));
  return { sorted, gaps: gapsOf(sorted) };
}
/** The same for every listed name and alias. */
export function nameGaps(idx: SanctionsIndex): { sorted: bigint[]; gaps: [bigint, bigint][] } {
  const sorted = sortedUnique(idx.names.map(([n]) => nameLeaf(n)));
  return { sorted, gaps: gapsOf(sorted) };
}

interface GapTree { root: string; witnessOf(i: number): { isLeft: boolean; sibling: string }[] }
const trees = new Map<string, Promise<GapTree>>();

/** A Merkle tree over the gaps, built bottom-up (empty subtrees use the usual zero hashes), so even 30,000 names build in seconds. */
async function buildTree(gaps: [bigint, bigint][], height: number): Promise<GapTree> {
  const { Field, Poseidon } = await zk();
  const leaves = 2 ** (height - 1);
  if (gaps.length > leaves) throw new Error("The OFAC list outgrew the circuit's tree: raise the tree height in lib/zk-claims-program.ts and rebuild the verification keys");
  const zeros = [Field(0)];
  for (let l = 1; l < height; l++) zeros.push(Poseidon.hash([zeros[l - 1], zeros[l - 1]]));
  const levels = [gaps.map(([lo, hi]) => Poseidon.hash([Field(lo), Field(hi)]))];
  for (let l = 1; l < height; l++) {
    const below = levels[l - 1];
    const above = [];
    for (let i = 0; i < Math.ceil(below.length / 2); i++) above.push(Poseidon.hash([below[2 * i], below[2 * i + 1] ?? zeros[l - 1]]));
    levels.push(above);
  }
  const at = (l: number, i: number) => levels[l][i] ?? zeros[l];
  return {
    root: at(height - 1, 0).toString(),
    witnessOf: (i) => Array.from({ length: height - 1 }, (_, l) => { const idx = i >> l; return { isLeft: idx % 2 === 0, sibling: at(l, idx ^ 1).toString() }; }),
  };
}

/** The public root of the OFAC address list: anyone with the list can recompute it. */
export async function sanctionsTree(idx: SanctionsIndex) {
  const { TREE_HEIGHT } = await zk();
  const { sorted, gaps } = listGaps(idx);
  const key = `addr:${idx.listDate}:${sorted.length}`;
  if (!trees.has(key)) trees.set(key, buildTree(gaps, TREE_HEIGHT));
  const tree = await trees.get(key)!;
  return { tree, root: tree.root, gaps, sorted };
}
/** The public root of the OFAC name list. */
export async function nameTree(idx: SanctionsIndex) {
  const { NAME_TREE_HEIGHT } = await zk();
  const { sorted, gaps } = nameGaps(idx);
  const key = `name:${idx.listDate}:${sorted.length}`;
  if (!trees.has(key)) trees.set(key, buildTree(gaps, NAME_TREE_HEIGHT));
  const tree = await trees.get(key)!;
  return { tree, root: tree.root, gaps, sorted };
}

// ---------- Preparing a claim: everything the prover needs, as plain JSON ----------
export interface PreparedClaim {
  kind: ClaimKind;
  /** A public label for the claim, with nothing secret in it. */
  label: string;
  subject: string;
  private: Record<string, unknown>;
  public: Record<string, unknown>;
}

export const subjectOf = (what: string) => sha(`claim-subject:${what}`);

async function prepareClearance(kind: "sanctions" | "name", item: bigint, tree: GapTree, gaps: [bigint, bigint][], sorted: bigint[], listDate: string, subjectHex: string, label: string, what: string): Promise<PreparedClaim> {
  if (sorted.includes(item)) throw new Error(`That ${what} is on the OFAC list, so no clearance proof exists for it`);
  const i = gaps.findIndex(([lo, hi]) => lo < item && item < hi);
  if (i < 0) throw new Error("No gap contains this item");
  const { Poseidon, Field } = await zk();
  const salt = randomField();
  return {
    kind,
    label,
    subject: subjectHex,
    public: { listRoot: tree.root, listDate, itemCommitment: Poseidon.hash([Field(item), Field(salt)]).toString() },
    private: { item: item.toString(), salt, lo: gaps[i][0].toString(), hi: gaps[i][1].toString(), witness: tree.witnessOf(i) },
  };
}

export async function prepareSanctions(address: string, subjectHex: string, idx?: SanctionsIndex): Promise<PreparedClaim> {
  const index = idx ?? (await loadSanctions());
  if (!index) throw new Error("The OFAC list could not be loaded, so no clearance can be proved");
  const { tree, gaps, sorted } = await sanctionsTree(index);
  return prepareClearance("sanctions", addressLeaf(address), tree, gaps, sorted, index.listDate, subjectHex, `A payee is not on the OFAC list dated ${index.listDate}`, "address");
}

/**
 * A vendor's name is not on the OFAC list of names and aliases, matched exactly after normalising (lowercase, no accents or punctuation, no
 * company-form words). A near miss ("Shadow Exchenge") is not covered: the ordinary screening still warns on those.
 */
export async function prepareName(name: string, subjectHex: string, idx?: SanctionsIndex): Promise<PreparedClaim> {
  const { normalizeName } = await import("./sanctions");
  const n = normalizeName(name);
  if (n.length < 3) throw new Error("That name is too short to screen");
  const index = idx ?? (await loadSanctions());
  if (!index) throw new Error("The OFAC list could not be loaded, so no clearance can be proved");
  const { tree, gaps, sorted } = await nameTree(index);
  return prepareClearance("name", nameLeaf(n), tree, gaps, sorted, index.listDate, subjectHex, `A name is not on the OFAC list dated ${index.listDate} (exact match)`, "name");
}

/** What a payee's (or a name's) commitment would be, so a person given the item and the salt can check a proof is about it. */
export async function payeeCommitment(address: string, salt: string) {
  const { Poseidon, Field } = await zk();
  return Poseidon.hash([Field(addressLeaf(address)), Field(salt)]).toString();
}
export async function nameCommitment(name: string, salt: string) {
  const { Poseidon, Field } = await zk();
  const { normalizeName } = await import("./sanctions");
  return Poseidon.hash([Field(nameLeaf(normalizeName(name))), Field(salt)]).toString();
}

export async function prepareCredential(kind: "vendor" | "business", vendorName: string | undefined, subjectHex: string): Promise<PreparedClaim> {
  const rec = kind === "vendor" ? state().vendors.find((v) => v.name === vendorName)?.kyb : getBusiness(currentBiz())?.kyb;
  if (kind === "vendor" && !state().vendors.some((v) => v.name === vendorName)) throw new Error("Unknown vendor");
  if (rec?.status !== "verified") throw new Error(`${kind === "vendor" ? "This vendor" : "This business"} has not passed verification, so there is nothing to attest (${rec?.status ?? "not started"})`);
  const { Field, UInt64, Poseidon, KIND_VENDOR, KIND_BUSINESS } = await zk();
  const kindCode = kind === "vendor" ? KIND_VENDOR : KIND_BUSINESS;
  const subjectId = hex31(sha(`${kind}:${currentBiz()}:${vendorName ?? ""}`));
  const validUntil = nowSeconds() + CREDENTIAL_DAYS * 86_400;
  const salt = randomField();
  const att = await attested([Field(kindCode), Field(subjectId), UInt64.from(validUntil).value], { kind, biz: currentBiz(), vendor: vendorName, inquiryId: rec.inquiryId, subjectId: subjectId.toString(), validUntil });
  return {
    kind,
    label: kind === "vendor" ? "A vendor passed identity verification (issuer-attested)" : "This business passed identity verification (issuer-attested)",
    subject: subjectHex,
    public: { issuers: att.issuers, threshold: att.threshold, kind: kindCode, asOf: nowSeconds(), subjectCommitment: Poseidon.hash([Field(subjectId), Field(salt)]).toString(), validUntil },
    private: { subjectId: subjectId.toString(), salt, validUntil, signatures: att.signatures },
  };
}

export async function prepareSolvency(minUsd: number, subjectHex: string): Promise<PreparedClaim> {
  if (!(minUsd > 0)) throw new Error("Give the amount to prove as more than zero");
  const { Field, Poseidon, UInt64, MAX_ACCOUNTS } = await zk();
  const balances = (await services.treasuryBalances()).filter((b) => b.usd).map((b) => Math.round(b.amount * 100));
  if (!balances.length) throw new Error("No balances could be read for this treasury (a confidential treasury's balance is private and is not read here)");
  if (balances.length > MAX_ACCOUNTS) throw new Error(`The proof covers at most ${MAX_ACCOUNTS} balances`);
  const padded = [...balances, ...Array.from({ length: MAX_ACCOUNTS - balances.length }, () => 0)];
  const salt = randomField();
  const takenAt = nowSeconds();
  const commitment = Poseidon.hash([...padded.map((c) => UInt64.from(c).value), Field(salt), UInt64.from(takenAt).value]);
  const att = await attested([commitment, UInt64.from(takenAt).value], { kind: "solvency", account: cfg().TREASURY_ACCOUNT, balances: padded, salt, takenAt, commitment: commitment.toString() });
  return {
    kind: "solvency",
    label: `The treasury held at least $${minUsd.toLocaleString()}`,
    subject: subjectHex,
    public: { issuers: att.issuers, threshold: att.threshold, snapshotCommitment: commitment.toString(), minTotalCents: Math.round(minUsd * 100), asOf: takenAt, maxAgeSeconds: SNAPSHOT_MAX_AGE_SECONDS },
    private: { balances: padded, salt, takenAt, signatures: att.signatures },
  };
}

export interface GateInput { kind: 1 | 2 | 3; a: number; b?: number; c?: number }
/** A circuit of up to MAX_TOTAL_GATES gates, committed as a hash chain over the gates padded to whole chunks of 32. */
export async function prepareCircuit(gates: GateInput[], maxQubits: number, maxToffoli: number, subjectHex: string): Promise<PreparedClaim> {
  const { Field, Poseidon, CHUNK_GATES } = await zk();
  if (!gates.length) throw new Error("The circuit has no gates");
  if (gates.length > MAX_TOTAL_GATES) throw new Error(`This proof covers circuits of up to ${MAX_TOTAL_GATES} gates`);
  const padTo = Math.ceil(gates.length / CHUNK_GATES) * CHUNK_GATES;
  const rows = [...gates.map((g) => ({ kind: g.kind as number, a: g.a, b: g.b ?? 0, c: g.c ?? 0 })), ...Array.from({ length: padTo - gates.length }, () => ({ kind: 0, a: 0, b: 0, c: 0 }))];
  const salt = randomField();
  let h = Field(salt);
  for (const g of rows) h = Poseidon.hash([h, Field(g.kind), Field(g.a), Field(g.b), Field(g.c)]);
  return {
    kind: "circuit",
    label: `A hidden circuit uses at most ${maxQubits} qubits and ${maxToffoli} Toffoli gates`,
    subject: subjectHex,
    public: { circuitCommitment: h.toString(), maxQubits, maxToffoli },
    private: { gates: rows, salt },
  };
}

// ---------- Proving ----------
export interface ClaimArtifact {
  version: 1;
  kind: ClaimKind;
  label: string;
  createdAt: string;
  system: string;
  /** Public facts only, for people to read; what counts is the proof's own public input. */
  statement: Record<string, unknown>;
  proof: { publicInput: string[]; publicOutput: string[]; maxProofsVerified: 0 | 1 | 2; proof: string };
}

export async function proveClaim(p: PreparedClaim): Promise<ClaimArtifact> {
  const z = await zk();
  await compileClaim(p.kind);
  const F = z.Field, pr = p.private as Record<string, any>, pu = p.public as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const subject = F(hex31(p.subject));
  const keys = (list: string[]) => list.map((k) => z.PublicKey.fromBase58(k));
  const sigs = (list: string[]) => list.map((s) => z.Signature.fromBase58(s));
  let proof;
  if (p.kind === "sanctions" || p.kind === "name") {
    const rows = pr.witness.map((w: { isLeft: boolean; sibling: string }) => ({ isLeft: w.isLeft, sibling: F(w.sibling) }));
    const st = new z.ClearanceStatement({ listRoot: F(pu.listRoot), subject, itemCommitment: F(pu.itemCommitment) });
    ({ proof } = p.kind === "sanctions"
      ? await z.SanctionsClearance.clear(st, F(pr.item), F(pr.salt), F(pr.lo), F(pr.hi), new z.ListWitness(rows))
      : await z.NameClearance.clear(st, F(pr.item), F(pr.salt), F(pr.lo), F(pr.hi), new z.NameWitness(rows)));
  } else if (p.kind === "vendor" || p.kind === "business") {
    const st = new z.CredentialStatement({ issuers: keys(pu.issuers), threshold: F(pu.threshold), subject, kind: F(pu.kind), subjectCommitment: F(pu.subjectCommitment), asOf: z.UInt64.from(pu.asOf) });
    ({ proof } = await z.VerifiedCredential.prove(st, F(pr.subjectId), F(pr.salt), z.UInt64.from(pr.validUntil), sigs(pr.signatures)));
  } else if (p.kind === "solvency") {
    const st = new z.SolvencyStatement({ issuers: keys(pu.issuers), threshold: F(pu.threshold), subject, snapshotCommitment: F(pu.snapshotCommitment), minTotalCents: z.UInt64.from(pu.minTotalCents), asOf: z.UInt64.from(pu.asOf), maxAgeSeconds: z.UInt64.from(pu.maxAgeSeconds) });
    ({ proof } = await z.Solvency.prove(st, (pr.balances as number[]).map((c) => z.UInt64.from(c)), F(pr.salt), z.UInt64.from(pr.takenAt), sigs(pr.signatures)));
  } else {
    const rows = (pr.gates as { kind: number; a: number; b: number; c: number }[]).map((g) => new z.Gate({ kind: F(g.kind), a: F(g.a), b: F(g.b), c: F(g.c) }));
    const chunks = Array.from({ length: rows.length / z.CHUNK_GATES }, (_, i) => rows.slice(i * z.CHUNK_GATES, (i + 1) * z.CHUNK_GATES));
    // One recursive proof per chunk, each verifying the one before; then a last proof that checks the bounds and hides the counts.
    let walk = (await z.CircuitChunks.start(subject, chunks[0], F(pr.salt))).proof;
    for (const chunk of chunks.slice(1)) walk = (await z.CircuitChunks.extend(subject, walk, chunk)).proof;
    ({ proof } = await z.CircuitResources.bound(new z.ResourceStatement({ circuitCommitment: F(pu.circuitCommitment), subject, maxQubits: F(pu.maxQubits), maxToffoli: F(pu.maxToffoli) }), walk));
  }
  const json = proof.toJSON();
  return { version: 1, kind: p.kind, label: p.label, createdAt: new Date().toISOString(), system: SYSTEM, statement: { ...p.public, subject: p.subject }, proof: { publicInput: json.publicInput, publicOutput: json.publicOutput, maxProofsVerified: json.maxProofsVerified as 0 | 1 | 2, proof: json.proof } };
}

// ---------- Verifying ----------
export interface ClaimVerdict {
  valid: boolean;
  kind: ClaimKind;
  /** The statement as the proof itself carries it, decoded: this, not the artifact's own wording, is what was proved. */
  statement: Record<string, string>;
  /** Credentials and balances: the issuers named, and how many different ones had to sign. */
  issuers?: string[];
  threshold?: number;
  problems: string[];
}

/** The verification keys: the committed file by default, or the ones just compiled. */
export function committedKeys(): Record<string, { data: string; hash: string }> | null {
  try {
    return JSON.parse(readFileSync(CLAIMS_VK_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function decode(kind: ClaimKind, f: string[]): Promise<{ statement: Record<string, string>; issuers?: string[]; threshold?: number }> {
  const { PublicKey, Field, Bool } = await zk();
  const issuers = () => [0, 2, 4].map((i) => PublicKey.from({ x: Field(f[i]), isOdd: Bool(f[i + 1] === "1") }).toBase58());
  if (kind === "sanctions" || kind === "name") return { statement: { listRoot: f[0], subject: f[1], itemCommitment: f[2] } };
  if (kind === "vendor" || kind === "business") { const i = issuers(); return { issuers: i, threshold: Number(f[6]), statement: { issuers: i.join(","), threshold: f[6], subject: f[7], kind: f[8], subjectCommitment: f[9], asOf: f[10] } }; }
  if (kind === "solvency") { const i = issuers(); return { issuers: i, threshold: Number(f[6]), statement: { issuers: i.join(","), threshold: f[6], subject: f[7], snapshotCommitment: f[8], minTotalCents: f[9], asOf: f[10], maxAgeSeconds: f[11] } }; }
  return { statement: { circuitCommitment: f[0], subject: f[1], maxQubits: f[2], maxToffoli: f[3] } };
}

/**
 * Check a claim's proof with o1js against a verification key. `expect` adds what the verifier requires of the statement: the OFAC list roots
 * it accepts, the issuers it trusts (every issuer the proof names must be one of them) and how many different ones it needs to have signed,
 * and the subject it was asked about.
 */
export async function verifyClaim(a: ClaimArtifact, expect: { listRoots?: string[]; trustedIssuers?: string[]; issuer?: string; minThreshold?: number; subject?: string; keys?: Record<string, { data: string; hash: string }> } = {}): Promise<ClaimVerdict> {
  const problems: string[] = [];
  if (!CLAIM_KINDS.includes(a?.kind)) return { valid: false, kind: a?.kind, statement: {}, problems: ["Unknown kind of claim"] };
  const keys = expect.keys ?? committedKeys();
  const vk = keys?.[vkName(a.kind)];
  if (!vk) return { valid: false, kind: a.kind, statement: {}, problems: ["No verification key for this claim: run npm run zk:claims:vk"] };
  const { verify } = await zk();
  let ok = false;
  try {
    ok = await verify(a.proof, vk.data);
  } catch {
    ok = false;
  }
  if (!ok) problems.push("o1js rejected the proof");
  const d: { statement: Record<string, string>; issuers?: string[]; threshold?: number } = await decode(a.kind, a.proof.publicInput).catch(() => ({ statement: {} }));
  const s = d.statement;
  if ((a.kind === "sanctions" || a.kind === "name") && expect.listRoots && !expect.listRoots.includes(s.listRoot)) problems.push("The proof is about a list root this verifier does not recognise as OFAC's");
  const trusted = expect.trustedIssuers ?? (expect.issuer ? [expect.issuer] : undefined);
  if (trusted && d.issuers && d.issuers.some((k) => !trusted.includes(k))) problems.push("The proof names an issuer this verifier does not trust");
  if (expect.minThreshold !== undefined && d.threshold !== undefined && d.threshold < expect.minThreshold) problems.push(`The proof needs only ${d.threshold} issuer(s) to have signed, and this verifier wants ${expect.minThreshold}`);
  if (expect.subject && s.subject !== String(hex31(expect.subject))) problems.push("The proof is about a different subject");
  if ((a.kind === "vendor" || a.kind === "business") && s.kind !== (a.kind === "vendor" ? "1" : "2")) problems.push("The proof is of a different kind of credential");
  return { valid: problems.length === 0, kind: a.kind, statement: s, issuers: d.issuers, threshold: d.threshold, problems };
}

// ---------- Jobs: the app prepares, a separate process proves ----------
export interface ClaimRecord {
  id: string;
  biz: string;
  kind: ClaimKind;
  label: string;
  createdAt: string;
  status: "proving" | "done" | "failed";
  error?: string;
  artifact?: ClaimArtifact;
}
const recordFile = (id: string) => join(DIR, `${id}.json`);
const jobFile = (id: string) => join(DIR, "jobs", `${id}.sealed`);
const rootsFile = join(DIR, "list-roots.json");

/** OFAC list roots this app has published (a clearance proof is about one of these). */
export function publishedRoots(): string[] {
  try {
    return JSON.parse(readFileSync(rootsFile, "utf8")) as string[];
  } catch {
    return [];
  }
}
function rememberRoot(root: string) {
  const all = publishedRoots();
  if (all.includes(root)) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(rootsFile, JSON.stringify([...all, root]));
}

/** Prepare a claim in this process, then prove it in another. Returns at once; the record turns "done" when the proof exists. */
export async function startClaim(prepared: PreparedClaim): Promise<ClaimRecord> {
  mkdirSync(join(DIR, "jobs"), { recursive: true });
  const id = `clm_${randomBytes(6).toString("hex")}`;
  if (prepared.kind === "sanctions" || prepared.kind === "name") rememberRoot(String(prepared.public.listRoot));
  const rec: ClaimRecord = { id, biz: currentBiz(), kind: prepared.kind, label: prepared.label, createdAt: new Date().toISOString(), status: "proving" };
  writeFileSync(jobFile(id), sealText(JSON.stringify(prepared)));
  save(rec);
  if (process.env.BLUVFI_ZK_NO_SPAWN === "1") return rec; // tests run the job themselves
  const child = spawn("npx", ["tsx", "scripts/zk-claim-prove.ts", id], { cwd: process.cwd(), detached: true, stdio: "ignore", shell: process.platform === "win32", env: process.env });
  child.on("error", () => {});
  child.unref();
  return rec;
}

function save(rec: ClaimRecord) {
  mkdirSync(DIR, { recursive: true });
  const tmp = recordFile(rec.id) + ".tmp";
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, recordFile(rec.id));
}

/** Run by scripts/zk-claim-prove.ts: prove the job, store the proof, delete the private data. */
export async function runClaimJob(id: string) {
  const rec = JSON.parse(readFileSync(recordFile(id), "utf8")) as ClaimRecord;
  try {
    const prepared = JSON.parse(openText(readFileSync(jobFile(id), "utf8")).text) as PreparedClaim;
    rec.artifact = await proveClaim(prepared);
    rec.status = "done";
  } catch (e) {
    rec.status = "failed";
    rec.error = (e as Error).message.slice(0, 300);
  } finally {
    rmSync(jobFile(id), { force: true });
  }
  save(rec);
}

export function claimsFor(biz: string): ClaimRecord[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => /^clm_[0-9a-f]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as ClaimRecord).filter((r) => r.biz === biz).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function claimById(id: string, biz: string): ClaimRecord | undefined {
  if (!/^clm_[0-9a-f]+$/.test(id) || !existsSync(recordFile(id))) return undefined;
  const rec = JSON.parse(readFileSync(recordFile(id), "utf8")) as ClaimRecord;
  return rec.biz === biz ? rec : undefined;
}
