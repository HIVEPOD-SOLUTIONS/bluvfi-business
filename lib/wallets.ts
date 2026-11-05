import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keyFileInfo, readKeyFile, writeKeyFile } from "./keyfile";

/**
 * The two small wallets the platform's operator runs beside the app (the Wallets page and the x402:payer and
 * confidential:test scripts both use this file):
 *  - the x402 payer, a Base wallet that pays the APIs the agent buys (its signing service runs as its own process);
 *  - the confidential-test account, a throwaway NEAR mainnet account for trying a confidential payout.
 * Their key files are sealed under a passphrase (lib/keyfile.ts). The passphrase arrives with each request, is used in
 * memory, and is never stored; each file keeps its public address in the clear so status needs no passphrase.
 */
export type Net = "testnet" | "mainnet";
/** Where the key files live: the project folder, or another (BLUVFI_WALLETS_ROOT; tests use a temporary one). */
const ROOT = process.env.BLUVFI_WALLETS_ROOT ?? ".";
const dirOf = (net: Net) => join(ROOT, net === "mainnet" ? ".mainnet" : ".testnet");
export const payerFile = (net: Net) => join(dirOf(net), "x402-payer.json");
export const payerSpentFile = (net: Net) => join(dirOf(net), "x402-payer-spent.json");
export const CONFIDENTIAL_FILE = join(dirOf("mainnet"), "confidential-test.json");
export const MIN_PASSPHRASE = 12;

const BASE = {
  mainnet: { rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "Base mainnet" },
  testnet: { rpc: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chain: "Base Sepolia (test USDC)" },
};
const NEAR_MAINNET_RPC = "https://rpc.mainnet.near.org";

export interface PayerKey { privateKey: `0x${string}`; token: string }
export interface ConfidentialKey { accountId: string; secret: string }

const payerMeta = (k: PayerKey) => ({ address: privateKeyToAccount(k.privateKey).address });
const implicitOf = (k: KeyPair) => Buffer.from(k.getPublicKey().data).toString("hex");
const confidentialMeta = (k: ConfidentialKey) => ({ address: k.accountId });

function checkPassphrase(p: string | undefined, creating: boolean): string {
  if (!p) throw new Error("Enter the passphrase.");
  if (creating && p.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  return p;
}

/** The payer's address: from the public meta if sealed, else from the plain file (which is readable anyway). */
function addressOf(file: string, metaOf: (v: never) => Record<string, string>): string | undefined {
  const info = keyFileInfo(file);
  if (!info.exists) return undefined;
  if (info.sealed) return info.meta?.address;
  try {
    return metaOf(JSON.parse(readFileSync(file, "utf8")) as never).address;
  } catch {
    return undefined;
  }
}

async function baseUsdc(net: Net, address: string): Promise<number | null> {
  try {
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const r = await fetch(BASE[net].rpc, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BASE[net].usdc, data }, "latest"] }),
    });
    const j = (await r.json()) as { result?: string };
    return Number(BigInt(j.result ?? "0x0")) / 1e6;
  } catch {
    return null;
  }
}

async function nearBalance(account: string): Promise<number | null> {
  try {
    const r = await fetch(NEAR_MAINNET_RPC, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
    });
    const j = (await r.json()) as { result?: { amount: string } };
    return j.result ? Number(BigInt(j.result.amount) / BigInt(1e18)) / 1e6 : 0;
  } catch {
    return null;
  }
}

function spentToday(net: Net): number {
  try {
    const s = JSON.parse(readFileSync(payerSpentFile(net), "utf8")) as { day: string; usd: number };
    return s.day === new Date().toISOString().slice(0, 10) ? s.usd : 0;
  } catch {
    return 0;
  }
}

export interface WalletStatus {
  id: string;
  kind: "payer" | "confidential";
  net: Net;
  label: string;
  file: string;
  exists: boolean;
  sealed: boolean;
  /** Mainnet key files must be sealed; a plain one is flagged so it can be encrypted. */
  mustSeal: boolean;
  address?: string;
  balance?: { amount: number | null; unit: string };
  spentToday?: number;
  caps?: { perPayment: number; perDay: number };
}

/** Every wallet's status, with no passphrase: whether its file exists and is sealed, its address and its balance. */
export async function walletsStatus(): Promise<WalletStatus[]> {
  const caps = { perPayment: Number(process.env.X402_PAYER_MAX_USD ?? 0.05), perDay: Number(process.env.X402_PAYER_MAX_DAY_USD ?? 1) };
  const payers = (["testnet", "mainnet"] as Net[]).map(async (net): Promise<WalletStatus> => {
    const file = payerFile(net);
    const info = keyFileInfo(file);
    const address = addressOf(file, payerMeta as never);
    return {
      id: `payer-${net}`, kind: "payer", net, label: `x402 payer (${BASE[net].chain})`, file, exists: info.exists, sealed: info.sealed, mustSeal: net === "mainnet",
      address, balance: address ? { amount: await baseUsdc(net, address), unit: "USDC" } : undefined, spentToday: info.exists ? spentToday(net) : undefined, caps,
    };
  });
  const cInfo = keyFileInfo(CONFIDENTIAL_FILE);
  const cAddress = addressOf(CONFIDENTIAL_FILE, confidentialMeta as never);
  const confidential: WalletStatus = {
    id: "confidential-mainnet", kind: "confidential", net: "mainnet", label: "Confidential-payout test account (NEAR mainnet)", file: CONFIDENTIAL_FILE,
    exists: cInfo.exists, sealed: cInfo.sealed, mustSeal: true, address: cAddress,
    balance: cAddress ? { amount: await nearBalance(cAddress), unit: "NEAR" } : undefined,
  };
  return [...(await Promise.all(payers)), confidential];
}

const byId = (id: string): { file: string; kind: "payer" | "confidential"; net: Net } => {
  if (id === "payer-testnet") return { file: payerFile("testnet"), kind: "payer", net: "testnet" };
  if (id === "payer-mainnet") return { file: payerFile("mainnet"), kind: "payer", net: "mainnet" };
  if (id === "confidential-mainnet") return { file: CONFIDENTIAL_FILE, kind: "confidential", net: "mainnet" };
  throw new Error("Unknown wallet");
};

/** Makes a wallet that does not exist yet, sealed under the passphrase. Returns its public address. */
export function createWallet(id: string, passphrase?: string): { address: string } {
  const w = byId(id);
  if (existsSync(w.file)) throw new Error("This wallet already exists. Its key is never replaced here, so nothing in it can be lost.");
  const pass = checkPassphrase(passphrase, true);
  mkdirSync(dirOf(w.net), { recursive: true });
  if (w.kind === "payer") {
    const k: PayerKey = { privateKey: generatePrivateKey(), token: randomBytes(24).toString("hex") };
    writeKeyFile(w.file, k, { passphrase: pass, requireSeal: true, meta: payerMeta(k) });
    return payerMeta(k);
  }
  const key = KeyPair.fromRandom("ed25519");
  const k: ConfidentialKey = { accountId: implicitOf(key), secret: key.toString() };
  writeKeyFile(w.file, k, { passphrase: pass, requireSeal: true, meta: confidentialMeta(k) });
  return confidentialMeta(k);
}

/** Opens a wallet's key file with the passphrase. A plain file from an older version is sealed in place on the way. */
function open<T>(id: string, passphrase?: string): T {
  const w = byId(id);
  const metaOf = (w.kind === "payer" ? payerMeta : confidentialMeta) as (v: T) => Record<string, string>;
  return readKeyFile<T>(w.file, { passphrase: checkPassphrase(passphrase, !keyFileInfo(w.file).sealed), requireSeal: true, meta: metaOf });
}

/** Seals a plain key file left by an older version. */
export function encryptWallet(id: string, passphrase?: string): { sealed: true } {
  if (keyFileInfo(byId(id).file).sealed) throw new Error("This key file is already encrypted.");
  open(id, passphrase);
  return { sealed: true };
}

/** The payer's shared secret, for X402_PAYER_TOKEN. Needs the passphrase; shown once to the operator who asked. */
export function revealPayerToken(id: string, passphrase?: string): { token: string } {
  if (byId(id).kind !== "payer") throw new Error("Only the payer has a token.");
  return { token: open<PayerKey>(id, passphrase).token };
}

/** For the scripts: open a key file with the passphrase from the environment. */
export const openPayer = (net: Net, passphrase?: string) =>
  readKeyFile<PayerKey>(payerFile(net), { passphrase, requireSeal: net === "mainnet", meta: payerMeta });
export const openConfidential = (passphrase?: string) =>
  readKeyFile<ConfidentialKey>(CONFIDENTIAL_FILE, { passphrase, requireSeal: true, meta: confidentialMeta });
