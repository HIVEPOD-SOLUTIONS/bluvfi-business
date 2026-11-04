// The agent's x402 spending, tested against real local HTTP servers (a paywalled API and a payer service). Imported first.
import "./setup";

export const X402_PORT = 47833;
process.env.X402_PAYER_URL = `http://127.0.0.1:${X402_PORT}/payer`;
