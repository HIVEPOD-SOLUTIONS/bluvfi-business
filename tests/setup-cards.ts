// One-time card tests: local servers that speak Stripe's, Ramp's and Rain's APIs stand in for them (a real run needs your own issuing account).
import "./setup";

export const STRIPE_PORT = 47870;
/** The operator's own business's Stripe webhook signing secret (a signed-up business sets its own on the Settings page). */
export const OPERATOR_WEBHOOK_SECRET = "whsec_cards_test";
process.env.STRIPE_API_BASE = `http://127.0.0.1:${STRIPE_PORT}`;
process.env.STRIPE_WEBHOOK_SECRET = OPERATOR_WEBHOOK_SECRET;
