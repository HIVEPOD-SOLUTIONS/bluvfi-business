// Sign in with Privy, tested against a real local HTTP server that speaks Privy's two endpoints (the app's JWKS and the
// user lookup), with tokens signed by a real ES256 key. Only Privy's own servers are stood in for: no Privy account
// exists for a test to use. The live check is the manual one in the README.
import "./setup";

export const PRIVY_PORT = 47831;
export const APP_ID = "test-app-id";
export const SECRET = "test-app-secret";
export const OWNER = "owner@acme.test";

process.env.PRIVY_APP_ID = APP_ID;
process.env.PRIVY_APP_SECRET = SECRET;
process.env.BLUVFI_OWNER_EMAIL = OWNER;
process.env.PRIVY_AUTH_URL = `http://127.0.0.1:${PRIVY_PORT}`;
process.env.PRIVY_API_URL = `http://127.0.0.1:${PRIVY_PORT}`;
// No token signers: everyone here signs in with Privy.
delete process.env.BLUVFI_SIGNERS;
