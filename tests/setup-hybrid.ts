// Hybrid custody (DAO vault + OutLayer spending wallet), for tests/hybrid.test.ts. Imported after ./setup and before any lib module.
import { KeyPair } from "near-api-js";

export const AGENT_KEY = KeyPair.fromRandom("ed25519");
process.env.CUSTODY = "hybrid";
process.env.DAO_ACCOUNT = "acme.sputnik-dao.near";
process.env.AGENT_ACCOUNT = "acme-agent.near";
process.env.AGENT_PRIVATE_KEY = AGENT_KEY.toString();
process.env.OUTLAYER_API_KEY = "wk_test";
process.env.OUTLAYER_WALLET_ACCOUNT = "acme-spend.near";
