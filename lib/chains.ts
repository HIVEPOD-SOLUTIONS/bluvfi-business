/** Names for the chains NEAR Intents (1Click) lists. A chain not here is shown by its key, so a new one still appears. */
const CHAIN_NAMES: Record<string, string> = {
  abs: "Abstract", aleo: "Aleo", aptos: "Aptos", arb: "Arbitrum", avax: "Avalanche", base: "Base", bch: "Bitcoin Cash", bera: "Berachain",
  bsc: "BNB Chain", btc: "Bitcoin", cardano: "Cardano", dash: "Dash", doge: "Dogecoin", eth: "Ethereum", fogo: "Fogo", gnosis: "Gnosis",
  hypercore: "Hyperliquid", ltc: "Litecoin", miden: "Miden", monad: "Monad", movement: "Movement", near: "NEAR", op: "Optimism", plasma: "Plasma",
  pol: "Polygon", scroll: "Scroll", sol: "Solana", starknet: "Starknet", stellar: "Stellar", sui: "Sui", ton: "TON", tron: "Tron",
  xlayer: "X Layer", xrp: "XRP Ledger", zec: "Zcash",
};
export const chainName = (key: string) => CHAIN_NAMES[key] ?? key.toUpperCase();

const EVM = /^0x[0-9a-fA-F]{40}$/;
/**
 * The chains the treasury can pay out on, each with the address format a payee must give. A chain is here only if
 * NEAR Intents can deliver a stablecoin there and its addresses can be checked before anything is proposed; that
 * check, then 1Click's own quote, then the council's policy all stand between a typo and a lost payment.
 *
 * APPEND ONLY: the order is the chain's code in the zero-knowledge policy proof (lib/zk.ts, at most 31 entries).
 * Paying on a new chain is still off until the council adds it to the policy's allowed chains.
 */
export const PAYOUT_CHAINS: { key: string; address: RegExp; example: string }[] = [
  { key: "near", address: /^((?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+|[0-9a-f]{64})$/, example: "northwind.near" },
  { key: "eth", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "arb", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "base", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "sol", address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, example: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV" },
  { key: "bsc", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "pol", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "op", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "avax", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "gnosis", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "scroll", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "bera", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "monad", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "xlayer", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "plasma", address: EVM, example: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  { key: "tron", address: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, example: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7" },
  { key: "ton", address: /^((EQ|UQ|Ef|Uf|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})$/, example: "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEt1" },
  { key: "stellar", address: /^G[A-Z2-7]{55}$/, example: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { key: "sui", address: /^0x[0-9a-fA-F]{64}$/, example: "0x" + "a".repeat(64) },
  { key: "aptos", address: /^0x[0-9a-fA-F]{1,64}$/, example: "0x" + "a".repeat(64) },
];
export const PAYOUT_CHAIN_KEYS = PAYOUT_CHAINS.map((c) => c.key);
/** The stablecoins a payout may be made in. APPEND ONLY, for the same reason as the chains. */
export const PAYOUT_ASSETS = ["USDC", "USDT", "USDT0", "DAI", "USD1"];

export const isPayoutChain = (chain: string) => PAYOUT_CHAIN_KEYS.includes(chain);
/** Whether `address` is in the format `chain` uses. A chain we do not pay on has no valid address. */
export const validPayoutAddress = (chain: string, address: string) => !!PAYOUT_CHAINS.find((c) => c.key === chain)?.address.test(address);
export const payoutAddressExample = (chain: string) => PAYOUT_CHAINS.find((c) => c.key === chain)?.example ?? "";

/**
 * Whether two payout addresses are the same. EVM and hex addresses and NEAR accounts ignore case; most others
 * (Solana, Tron, TON, Stellar) do not, so a changed letter case there is a different address, never the same one.
 */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  const caseless = (x: string) => /^0x[0-9a-fA-F]+$/.test(x) || /^[0-9a-fA-F]{64}$/.test(x) || /\.near$/i.test(x);
  return caseless(a) && caseless(b) && a.toLowerCase() === b.toLowerCase();
}

/** A NEAR Intents asset id as 1Click lists them: nep141:/nep245: tokens, and its newer 1cs_v1:<chain>:<standard>:<address> form. */
export const INTENTS_ASSET_ID = /^(nep141|nep245|1cs_v1):[A-Za-z0-9._:-]{1,200}$/;

/** NEAR Intents asset ids (mainnet) known without asking 1Click. Other payout routes come from its token list (lib/intents-tokens.ts). */
export const ASSET_ID: Record<string, string> = {
  "near:USDC": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "eth:USDC": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  "base:USDC": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "arb:USDC": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "arb:USDT": "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
  "sol:USDC": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
};

/** USDC on NEAR mainnet (native, 6 decimals). */
export const NEAR_USDC_CONTRACT = process.env.BLUVFI_NETWORK === "testnet" ? (process.env.NEAR_USDC_CONTRACT ?? "usdc.fakes.testnet") : "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** The names people write for a payout chain (in a payroll sheet, say), to its key. Unknown names come back as given, lowercased. */
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth", ether: "eth", mainnet: "eth", arbitrum: "arb", "arbitrum one": "arb", solana: "sol", bnb: "bsc", "bnb chain": "bsc", "bnb smart chain": "bsc", binance: "bsc", bep20: "bsc",
  polygon: "pol", matic: "pol", optimism: "op", avalanche: "avax", "avalanche c-chain": "avax", xdai: "gnosis", berachain: "bera", "x layer": "xlayer", okx: "xlayer",
  trc20: "tron", trx: "tron", toncoin: "ton", xlm: "stellar", apt: "aptos", erc20: "eth",
};
export const payoutChainFromName = (name: string) => {
  const n = name.trim().toLowerCase();
  return CHAIN_ALIASES[n] ?? n;
};
