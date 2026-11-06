// Passport checks (Self), for tests/passport.test.ts. Imported after ./setup and before any lib module. Self's calls are faked in the test.
process.env.SELF_API_KEY = "sk_test_passport";
process.env.SELF_FLOW_ID = "00000000-0000-4000-8000-000000000001";
process.env.SELF_WEBHOOK_SECRET = "whsec_test";
process.env.SELF_ORG_ID = "00000000-0000-4000-8000-000000000002";
