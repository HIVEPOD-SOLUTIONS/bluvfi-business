export type Verdict = "allow" | "warn" | "block";
export type Confidentiality = "public" | "basic" | "advanced";
/** email is manual (a human records the answer); telegram handle is the vendor chat id; voice is an E.164 number. */
export type Channel = "email" | "telegram" | "voice";
export type Rail = "intents" | "x402" | "card";

export interface Invoice {
  id: string;
  vendorName: string;
  vendorDomain: string;
  vendorContact: { channel: Channel; handle: string };
  invoiceNumber: string;
  poNumber: string;
  amountUsd: number;
  asset: string;
  chain: string;
  payoutAddress: string;
  /** Raw text of the invoice, including anything a scammer hid in it. */
  text: string;
  receivedAt: string;
}

export interface PurchaseOrder {
  po: string;
  vendorName: string;
  amountUsd: number;
}

/** Where a business or vendor stands with identity verification (KYB) at the verification provider. */
export type KybStatus = "pending" | "submitted" | "review" | "verified" | "declined" | "expired";
export interface KybRecord {
  status: KybStatus;
  inquiryId: string;
  updatedAt: string;
  /** When Persona's decision became final (verified or declined): retention counts from here. */
  decidedAt?: string;
  /** When the documents were deleted at Persona (redacted), leaving only this decision. */
  redactedAt?: string;
}

/**
 * A passport proof (Self, lib/passport.ts): a zero-knowledge proof from the person's passport chip that a real passport holder, passing
 * the checks of the Self flow (OFAC screening and a minimum age), is behind it. No name, number or document is disclosed. `nullifier` is
 * the same for the same passport here, so one passport cannot quietly verify several parties.
 */
export interface PassportRecord {
  provider: "self";
  status: "pending" | "verified" | "declined";
  /** Our id for the Self session (its external_uuid). */
  sessionRef: string;
  updatedAt: string;
  nullifier?: string;
  verifiedAt?: string;
  environment?: "test" | "live";
  /** The predicates the proof was checked against (age, OFAC), never personal data. */
  checks?: Record<string, string | number | boolean>;
  note?: string;
}

export interface Vendor {
  name: string;
  /** Business verification of this vendor (lib/kyb.ts); missing means never started. */
  kyb?: KybRecord;
  /** A passport proof for this vendor (lib/passport.ts), which the council may accept instead. */
  passport?: PassportRecord;
  domain: string;
  verifiedContact: { channel: Channel; handle: string };
  payout: { chain: string; asset: string; address: string };
  lastPaidAt?: string;
  paidInvoiceNumbers: string[];
}

export interface Policy {
  version: number;
  perPaymentLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  holdWindowMinutes: number;
  allowedChains: string[];
  allowedAssets: string[];
  vendorAllowlist: string[];
  x402DailyLimitUsd: number;
  /**
   * Optional privacy, set as policy: no payment goes out with less confidentiality than this. "public" means no floor.
   * At "advanced", DAO payout proposals also leave the vendor, invoice and amount text out of their public description.
   * Missing on versions made before it existed, which means "public".
   */
  privacyFloor?: Confidentiality;
  /** What kind of treasury this is (lib/privacy.ts); it fills in the rules below, which are what is enforced. Missing means none. */
  privacyProfile?: import("./privacy").PrivacyProfile;
  /** Payments at or above an amount are raised to a level. */
  privacyTiers?: { aboveUsd: number; level: Confidentiality }[];
  /** Vendors who need privacy (payroll, investors, legal), by name: their payments are raised to a level. */
  privateVendors?: Record<string, Confidentiality>;
  /** Refuse payouts unless every key that can move money (agent, relayer, council) is post-quantum (ML-DSA). Missing means off. */
  requirePostQuantumKeys?: boolean;
  /** Tiered verification (lib/verify-tiers.ts): who must verify, and when. Missing on versions made before it existed. */
  verifyVendorsFromUsd?: number;
  verifyNewVendors?: boolean;
  verifyBusinessFromUsd?: number;
  verifyForPrivacy?: boolean;
  acceptPassportProof?: boolean;
  /** One-time cards (lib/cards.ts): the most the agent may put on cards in a day. Missing or 0 means the agent gets no cards. */
  cardDailyLimitUsd?: number;
  hash: string;
  createdAt: string;
}

export interface PolicyProposal {
  id: string;
  createdAt: string;
  changes: Omit<Policy, "version" | "hash" | "createdAt">;
  approvals: string[];
  threshold: number;
  status: "open" | "applied" | "rejected";
  /** Sputnik custody: the treasury DAO's council approves this change with a Vote proposal carrying `tag`. */
  dao?: { version: number; tag: string; from: string; description: string; kind: unknown; command: string; url: string; proposalId?: number; daoStatus?: string };
}

export interface CheckResult {
  id: string;
  label: string;
  verdict: Verdict;
  reason: string;
}

export interface Attestation {
  model: string;
  nonce: string;
  signingAddress: string;
  signingAlgo: "ed25519";
  gpuEvidence: { arch: string; nonce: string; verified: boolean; note: string };
  cpuEvidence: { type: "intel-tdx"; reportData: string; verified: boolean; note: string };
  source: AiSource;
  /** sha256 of the raw attestation report, kept in .data/attestations/ so it can be verified again (lib/nearai.ts). */
  reportHash?: string;
  /** NVIDIA NRAS signed verdict (JWT), checked against NVIDIA's published keys. */
  nrasToken?: string;
  /** False when NEAR AI did not take the decision schema as structured output; the reply was still held to it. */
  structured?: boolean;
}

/** live: fetched now. recorded: a real NEAR AI response replayed. demo-fixture: made locally for demo mode, never attested. */
export type AiSource = "live" | "recorded" | "demo-fixture";

export interface SignedDecision {
  chatId: string;
  model: string;
  content: string; // the model's message, taken from rawResponse
  /** The exact response body bytes; the signed response hash covers these, not the parsed message. */
  rawResponse: string;
  signatureKind: "provider_tee" | "gateway";
  /** provider_tee: `${model}:${sha256(request)}:${sha256(response)}`; gateway: `${sha256(request)}:${sha256(response)}` */
  text: string;
  signature: string;
  signingAddress: string;
  attestation: Attestation;
  source: AiSource;
}

export interface AiJudgment {
  decision: "pay" | "hold" | "block";
  riskScore: number;
  summary: string;
  reasons: string[];
}

export interface VerifiedPanel {
  attestation: {
    nonceBound: boolean;
    gpu: boolean;
    cpu: boolean;
    binding: boolean;
    model: string;
    nonce: string;
    source: AiSource;
    notes: string[];
    /** The raw report this decision was judged under. */
    reportHash?: string;
    /** The signing key passed the setup-time model check (lib/aimodel.ts). */
    registered?: boolean;
    /** The decision schema was enforced by NEAR AI as structured output. */
    structured?: boolean;
  };
  signature: {
    valid: boolean;
    requestBound: boolean;
    responseBound: boolean;
    signingAddress: string;
    text: string;
    signature: string;
    verifiedWhere: "offchain";
  };
  policyVersion: number;
  policyHash: string;
  /** Zero-knowledge proof of the policy check, made with o1js (lib/zk.ts). */
  zkProof: null | { system: string; status: "pending" | "verified" | "invalid"; note: string; outputBits?: number; proverSeconds?: number };
  pqSignature: { algo: "ML-DSA-65"; publicKey: string; signature: string; valid: boolean };
  /** The policy check signed with ML-DSA-65 and SLH-DSA (lib/pqcheck.ts): post-quantum, re-runnable by anyone. */
  policyCheckPq?: import("./pqcheck").PqPolicyCheck;
}

export type PaymentStatus =
  | "paid"
  | "approved"
  | "ready_to_send"
  | "proposed"
  | "awaiting_approval"
  | "held"
  | "blocked"
  | "cancelled";

export interface CallbackRecord {
  channel: string;
  handle: string;
  sentAt: string;
  message: string;
  status: "pending" | "confirmed" | "denied";
  answer?: string;
  answeredAt?: string;
  delivered: "telegram" | "voice" | "manual" | "demo";
}

/** A real 1Click quote. The treasury sends amountIn to depositAddress before the deadline. */
export interface Quote {
  depositAddress: string;
  /** Required by some origin chains; must be sent with the deposit and passed to the status call. */
  depositMemo?: string;
  amountIn: string;
  /** amountIn in raw units (USDC: 6 decimals), what the custodian transfers. */
  amountInRaw?: string;
  amountOut: string;
  /** The deadline 1Click reports. It is the same instant as `timeWhenInactive`: 1Click adds a margin of days to the deadline we ask for. */
  deadline?: string;
  /** When the deposit address stops working. Funds sent after this can be lost. */
  timeWhenInactive?: string;
  /** 1Click signature over the quote, shown by Trezu on the payment request. */
  signature?: string;
  /** A confidential quote: its deposit address is a Confidential Intents account, funded by a signed transfer intent, and its status is read with the treasury's login. */
  confidential?: boolean;
  source: "1click" | "1click-dry" | "demo-fixture";
}

/**
 * Where a released payment sits with the custodian (lib/custody.ts). The evidence hash is written onchain with it
 * (the DAO proposal description, or the ft_transfer memo), binding the payout to this record.
 */
export interface CustodyRecord {
  backend: "sputnik" | "outlayer";
  /** DAO proposal id, or OutLayer request id. */
  ref: string;
  url?: string;
  evidenceHash: string;
  submittedAt: string;
  state: "pending" | "executed" | "rejected" | "failed";
  detail: string;
  votes?: Record<string, string>;
  /** Sputnik: the proposal kind, needed verbatim by act_proposal. */
  kind?: unknown;
  approvalId?: string;
  txHash?: string;
  /** Hybrid custody: why the payout went to the spending wallet or to the DAO. */
  route?: string;
  /**
   * Confidential treasury: the proposal asks NEAR's MPC signer to sign this transfer intent. Once the council approves, the
   * signature is read from the vote and the intent is submitted to 1Click, which runs the payout.
   */
  confidential?: {
    intent: { standard: string; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string } };
    hashHex: string;
    depositAddress: string;
    intentHash?: string;
    submittedAt?: string;
  };
}

/** Hybrid custody: the agent's open request for the DAO to refill the spending wallet. */
export interface TopUp {
  proposalId: number;
  amountUsd: number;
  requestedAt: string;
  /** The DAO proposal's status as last read: InProgress, Approved, Rejected, … */
  status: string;
  url: string;
}

export interface Payment {
  id: string;
  invoice: Invoice;
  rail: Rail;
  status: PaymentStatus;
  headline: string;
  reason: string;
  confidentiality: Confidentiality;
  checks: CheckResult[];
  ai: AiJudgment;
  verified: VerifiedPanel;
  callback?: CallbackRecord;
  quote?: Quote;
  custody?: CustodyRecord;
  /** Public inputs of the policy-check proof for this payment (lib/zk.ts). */
  zkJob?: import("./zk").ZkJob;
  /** Transaction hash a signer reports after sending to the deposit address. */
  txRef?: string;
  settlement?: { status: string; checkedAt: string };
  holdUntil?: string;
  createdAt: string;
  redactedInput: string;
  /** Who stripped personal data before the model saw it. */
  redactedBy?: "near-ai+local-regex" | "local-regex";
  recordHash: string;
  approvedBy?: string;
  prevHash: string;
}

export interface BlocklistEntry {
  id: string;
  kind: "address" | "domain";
  value: string;
  reason: string;
  evidenceHash: string;
  reportedBy: string;
  at: string;
}

export interface Receivable {
  id: string;
  client: string;
  description: string;
  amountUsd: number;
  asset: string;
  chain: string;
  payTo: string;
  createdAt: string;
  status: "open" | "paid";
  deposit?: { chain: string; address: string; memo?: string; amountIn: string; deadline?: string };
  /** What 1Click last said about the deposit: a failed or expired one clears `deposit` so the client can start again. */
  settlement?: { status: string; checkedAt: string; note: string };
}

export interface ViewGrant {
  wrappedKey: string;
  id: string;
  grantee: string;
  expiresAt: string;
  createdAt: string;
  key: string; // shown once to the company; stored hashed
  keyHash: string;
  revoked: boolean;
}

export interface CheckRequest {
  payoutAddress: string;
  vendorName?: string;
  vendorDomain?: string;
  amountUsd?: number;
  chain?: string;
  invoiceText?: string;
}

export interface CheckResponse {
  verdict: Verdict;
  checks: CheckResult[];
  reasons: string[];
  checkedAt: string;
}

/**
 * A purchase the agent makes with a one-time card (lib/cards.ts). The card's number is never stored: it is handed over once, when the
 * card is issued, and only its last four digits are kept.
 */
export interface CardPurchase {
  id: string;
  merchant: string;
  merchantUrl?: string;
  /** The most the card can be charged, tax and shipping included. */
  amountUsd: number;
  reason: string;
  requestedBy: string;
  createdAt: string;
  status: "awaiting_approval" | "issued" | "used" | "closed" | "refused" | "failed";
  /** Signers who approved it, when it needed approval. */
  approvals: string[];
  needsApprovalBecause?: string;
  provider?: "stripe" | "ramp" | "rain" | "demo";
  cardId?: string;
  /** What closing the card needs, if not the card id (Ramp: the fund behind it). */
  closeRef?: string;
  last4?: string;
  expiresAt?: string;
  /** Charges seen on the card (Stripe's real-time authorizations), each approved or declined here. */
  authorizations: { at: string; amountUsd: number; merchant: string; approved: boolean; reason: string }[];
  note: string;
  closedAt?: string;
}
