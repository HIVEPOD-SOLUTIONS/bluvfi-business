// Tests that use the REAL NEAR AI Cloud. tests/real/setup.ts removes the NEAR AI key so Layer 1 tests cannot spend it; these need it, so it is read
// from .env.local (or the shell) first and put back after the other settings are in place. Import this first.
import "./stash-key";
import "./setup";

process.env.NEAR_AI_API_KEY = process.env.STASHED_NEAR_AI_KEY ?? "";
