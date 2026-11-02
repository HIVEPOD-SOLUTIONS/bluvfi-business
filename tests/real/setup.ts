// Layer 1 tests that use the REAL services, with nothing faked. Imported first by every file in tests/real.
//  - NEAR AI Cloud: no key is set, so the AI review genuinely cannot run and every payment is held for a human.
//  - 1Click: real dry-run quotes (ONECLICK_DRY=1): real prices, no deposit address, nothing can be paid.
//    1Click rejects a refund account that does not exist, so TREASURY_ACCOUNT is a real mainnet account (`near`);
//    in dry mode it is only a field in the quote request.
//  - Payee lookups go to the real NEAR and EVM RPCs.
process.env.BLUVFI_PERSIST = "0";
process.env.BLUVFI_MASTER_KEY = "ab".repeat(32);
process.env.BLUVFI_SIGNERS = "maya:maya-token-0123456789,devon:devon-token-0123456789";
process.env.TREASURY_ACCOUNT = "near";
process.env.ONECLICK_DRY = "1";
for (const k of ["NEAR_AI_API_KEY", "CUSTODY", "DAO_ACCOUNT", "AGENT_ACCOUNT", "AGENT_PRIVATE_KEY", "OUTLAYER_API_KEY", "BLUVFI_DEMO", "BLUVFI_NETWORK"]) delete process.env[k];
