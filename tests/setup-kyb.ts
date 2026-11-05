// Identity verification tests: a local server that speaks Persona's API stands in for Persona (a real run needs your own Persona account).
import "./setup";

export const PERSONA_PORT = 47860;
export const WEBHOOK_SECRET = "wbhsec_test_secret_0123456789";
process.env.PERSONA_API_KEY = "persona_sandbox_key_test";
process.env.PERSONA_BASE_URL = `http://127.0.0.1:${PERSONA_PORT}`;
process.env.PERSONA_TEMPLATE_VENDOR = "itmpl_vendor_test";
process.env.PERSONA_TEMPLATE_BUSINESS = "itmpl_business_test";
process.env.PERSONA_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.KYB_REQUIRED = "1";
