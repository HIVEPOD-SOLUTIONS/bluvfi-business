// Backpack Exchange: a local server that speaks its public and signed APIs stands in for it. Imported first.
import "./setup";

export const BP_PORT = 47892;
process.env.BACKPACK_API_BASE = `http://127.0.0.1:${BP_PORT}`;
process.env.BACKPACK_API_KEY = "test-backpack-key";
// A base64 32-byte ED25519 seed (the test's own, worth nothing).
export const BP_SECRET = Buffer.alloc(32, 7).toString("base64");
process.env.BACKPACK_API_SECRET = BP_SECRET;
