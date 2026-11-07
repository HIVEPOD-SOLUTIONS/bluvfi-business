// Bills: a local server that speaks Bitrefill's MCP (OAuth token, then JSON-RPC over event-stream) stands in for Bitrefill. Imported first.
import "./setup";

export const BITREFILL_PORT = 47880;
process.env.BITREFILL_MCP_BASE = `http://127.0.0.1:${BITREFILL_PORT}/mcp`;
delete process.env.BITREFILL_MCP_URL;
process.env.BITREFILL_CLIENT_ID = "test-client";
