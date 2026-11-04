// Layer 3 against the REAL 1Click API, with nothing faked and no funds. Unlike ./setup, ONECLICK_DRY is off, so 1Click
// gives real deposit addresses; a quote is free and expires unused, because this suite never sends anything to it.
// 1Click rejects a refund account that does not exist, so TREASURY_ACCOUNT is a real mainnet account (`near`).
import "./setup";

delete process.env.ONECLICK_DRY;
