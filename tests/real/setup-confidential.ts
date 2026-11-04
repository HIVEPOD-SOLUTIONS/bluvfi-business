// Confidential treasuries against the REAL 1Click test host and the real NEAR mainnet RPC, with nothing faked and no funds.
// The login is checked with a throwaway ed25519 key: a 64-hex implicit NEAR account is its own public key, so it needs no
// funding and nothing on chain. The confidential quote needs your 1Click partner key, read here from .env.local (ONECLICK_JWT)
// and never printed; without it those tests are skipped. A throwaway account holds no balance, so a payout it submits is
// accepted by 1Click and then ends FAILED, which moves no funds.
import { existsSync, readFileSync } from "node:fs";
import "./setup";

process.env.CONFIDENTIAL_API_URL = "https://1click-test.chaindefuser.com";

if (!process.env.ONECLICK_JWT && existsSync(".env.local")) {
  const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("ONECLICK_JWT="));
  const key = line?.slice("ONECLICK_JWT=".length).trim();
  if (key) process.env.ONECLICK_JWT = key;
}
export const HAS_PARTNER_KEY = !!process.env.ONECLICK_JWT;
