// A confidential treasury through a Sputnik DAO, for tests/confidential-flow.test.ts. Imported first.
import "./setup";
import "./setup-sputnik";

process.env.CONFIDENTIAL_TREASURY = "1";
process.env.ONECLICK_JWT = "partner-key-for-tests";
