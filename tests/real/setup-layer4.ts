// Layer 4 against the real services. tests/real/setup.ts removes the NEAR AI key so Layer 1 tests cannot spend it; the voice test needs it,
// so it is read from .env.local (or the shell) first and put back after the other settings are in place. Import this first.
import "./stash-key";
import "./setup-x402";

process.env.NEAR_AI_API_KEY = process.env.STASHED_NEAR_AI_KEY ?? "";
