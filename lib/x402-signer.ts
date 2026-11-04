import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Signs an x402 "exact" payment on an EVM chain: an EIP-3009 `transferWithAuthorization` for USDC. The payer service holds the key and
 * calls this; the app never does. The signature moves nothing by itself: it authorises one transfer of at most the stated amount to
 * the stated address, valid for a short window, which the API's facilitator then submits (and pays the gas for).
 */
export interface ExactEvmRequirements {
  scheme?: string;
  network: string;
  asset: string;
  payTo: string;
  /** x402 v2 names the price `amount`; v1 names it `maxAmountRequired`. */
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
}

/** The chains the payer may sign for, by the names x402 uses (v1 names and v2 CAIP-2 ids). */
export const CHAINS: Record<string, { id: number; testnet: boolean; usdc: string }> = {
  "eip155:8453": { id: 8453, testnet: false, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  base: { id: 8453, testnet: false, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  "eip155:84532": { id: 84532, testnet: true, usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" },
  "base-sepolia": { id: 84532, testnet: true, usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" },
};

export interface SignedPayment {
  /** What goes in the `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header: base64 of the payment payload. */
  paymentHeader: string;
  from: string;
  /** The amount authorised, in USDC's six-decimal units. */
  value: string;
  version: 1 | 2;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const evmAddress = (privateKey: `0x${string}`) => privateKeyToAccount(privateKey).address;

export async function signExactEvm(req: ExactEvmRequirements, privateKey: `0x${string}`, opts: { resource?: unknown; nowSec?: number } = {}): Promise<SignedPayment> {
  const chain = CHAINS[req.network];
  if (!chain) throw new Error(`The payer does not sign for the network ${req.network}`);
  if (req.scheme && req.scheme !== "exact") throw new Error(`The payer only signs the exact scheme, not ${req.scheme}`);
  if (req.asset.toLowerCase() !== chain.usdc) throw new Error(`The payer only pays in USDC on ${req.network}, not ${req.asset}`);
  const value = req.amount ?? req.maxAmountRequired;
  if (!value || !/^\d+$/.test(value)) throw new Error("The payment requirements have no readable amount");
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.payTo)) throw new Error("The payment requirements have no EVM address to pay");
  const version: 1 | 2 = req.amount !== undefined ? 2 : 1;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const account = privateKeyToAccount(privateKey);
  const authorization = {
    from: account.address,
    to: req.payTo,
    value,
    validAfter: String(now - 600),
    validBefore: String(now + (req.maxTimeoutSeconds ?? 60)),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? "USDC", version: req.extra?.version ?? "2", chainId: chain.id, verifyingContract: req.asset as `0x${string}` },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: authorization.from, to: authorization.to as `0x${string}`, value: BigInt(value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
  });
  const payload = { signature, authorization };
  const body = version === 2
    ? { x402Version: 2, ...(opts.resource ? { resource: opts.resource } : {}), accepted: req, payload }
    : { x402Version: 1, scheme: "exact", network: req.network, payload };
  return { paymentHeader: Buffer.from(JSON.stringify(body)).toString("base64"), from: account.address, value, version };
}
