// Self's real SDK, for tests/passport-sdk.test.ts. Imported after ./setup and before any lib module. Self's webhooks are signed by Svix:
// HMAC-SHA256 over "id.timestamp.body" with the base64 key after "whsec_". A real key, made here.
import { randomBytes } from "node:crypto";

export const WEBHOOK_KEY = randomBytes(24);
process.env.SELF_API_KEY = "sk_test_sdk";
process.env.SELF_FLOW_ID = "00000000-0000-4000-8000-000000000001";
process.env.SELF_WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString("base64")}`;
process.env.SELF_ORG_ID = "00000000-0000-4000-8000-000000000002";
