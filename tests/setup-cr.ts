// Cryptorefills: a local server that speaks its discovery API and its partner API stands in for Cryptorefills. Imported first.
import "./setup";

export const CR_PORT = 47890;
process.env.CRYPTOREFILLS_HOST = `http://127.0.0.1:${CR_PORT}`;
process.env.CRYPTOREFILLS_PARTNER_HOST = `http://127.0.0.1:${CR_PORT}/partner`;
process.env.CRYPTOREFILLS_PARTNER_ID = "test-partner-id";
