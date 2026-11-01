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

export interface Vendor {
  name: string;
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
  hash: string;
  createdAt: string;
}

export interface PolicyProposal {
  id: string;
  createdAt: string;
  changes: Omit<Policy, "version" | "hash" | "createdAt">;
  approvals: string[];
  threshold: number;
  status: "open" | "applied";
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
  deadline?: string;
  /** 1Click signature over the quote, shown by Trezu on the payment request. */
  signature?: string;
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
