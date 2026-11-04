import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { ACCOUNTS, DAO, keys } from "./setup";

/** Real testnet helpers for the council's side of the story: members voting and filing proposals with their own keys. */
export const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
export const memberAccount = (n: 1 | 2 | 3) => new Account(ACCOUNTS[`council${n}`], provider, keys[`council${n}`].secret as KeyPairString);

export async function view<T>(method: string, args: object = {}): Promise<T> {
  const r = await provider.query({ request_type: "call_function", finality: "optimistic", account_id: DAO, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from((r as unknown as { result: number[] }).result).toString()) as T;
}

export interface DaoProposal { id: number; proposer: string; description: string; kind: unknown; status: string; votes: Record<string, string> }
export const proposalById = (id: number) => view<DaoProposal>("get_proposal", { id });

/** A council member votes. `action` is a Sputnik Action. */
export async function vote(member: 1 | 2 | 3, id: number, action: "VoteApprove" | "VoteReject") {
  await memberAccount(member).callFunction({ contractId: DAO, methodName: "act_proposal", args: { id, action }, gas: teraToGas(150), deposit: BigInt(0) });
}

/** A vote with room for a proposal that calls another contract (the MPC signer needs 250 Tgas), returning the whole execution outcome. */
export async function voteWithOutcome(member: 1 | 2 | 3, id: number, action: "VoteApprove" | "VoteReject") {
  return memberAccount(member).callFunctionRaw({ contractId: DAO, methodName: "act_proposal", args: { id, action }, gas: teraToGas(300), deposit: BigInt(0) });
}

/** A council member files a proposal (they hold *:AddProposal, and the bond is 0). Returns its id. */
export async function addProposal(member: 1 | 2 | 3, description: string, kind: unknown): Promise<number> {
  return Number(await memberAccount(member).callFunction({ contractId: DAO, methodName: "add_proposal", args: { proposal: { description, kind } }, gas: teraToGas(50), deposit: BigInt(0) }));
}

/** Polls until `ready` returns a value (the chain needs a block or two to show a result). */
export async function until<T>(what: string, ready: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ready().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
