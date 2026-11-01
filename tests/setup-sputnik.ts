// Custody through a Sputnik DAO, for tests/custody.test.ts. Imported after ./setup and before any lib module.
import { KeyPair } from "near-api-js";

export const AGENT_KEY = KeyPair.fromRandom("ed25519");
export const RELAYER_KEY = KeyPair.fromRandom("ed25519");
process.env.CUSTODY = "sputnik";
process.env.DAO_ACCOUNT = "acme.sputnik-dao.near";
process.env.AGENT_ACCOUNT = "acme-agent.near";
process.env.AGENT_PRIVATE_KEY = AGENT_KEY.toString();
process.env.RELAYER_ACCOUNT = "acme-relayer.near";
process.env.RELAYER_PRIVATE_KEY = RELAYER_KEY.toString();
