// Per-business channels, tested against a real local HTTP server that speaks the two services the app calls out to
// (the Telegram Bot API and Agent Market). Their real servers cannot be used: they would need real bots and workers.
import "./setup-privy";

export const OUTSIDE_PORT = 47832;
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${OUTSIDE_PORT}/telegram`;
process.env.AGENT_MARKET_BASE_URL = `http://127.0.0.1:${OUTSIDE_PORT}/market`;
