export const CHAIN_LABEL: Record<string, string> = {
  near: "NEAR", eth: "Ethereum", arb: "Arbitrum", base: "Base", sol: "Solana",
};

/** NEAR Intents asset ids (mainnet). */
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
