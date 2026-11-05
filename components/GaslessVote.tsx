"use client";
import { KeyPair, type KeyPairString } from "near-api-js";
import { useRef, useState, useSyncExternalStore } from "react";
import { ErrorLine, useAction } from "./Actions";

/**
 * An earlier version kept a voting key in localStorage, where any script on the page could read it. It is deleted as
 * soon as this module loads in a browser, and the vote panel tells the council member to remove its public key from
 * their account too, since the key itself may already have leaked.
 */
const OLD_STORE = "bluvfi.voteKey";
const LEGACY: { account: string; publicKey: string } | null = (() => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(OLD_STORE);
    if (!raw) return null;
    localStorage.removeItem(OLD_STORE);
    const k = JSON.parse(raw) as { account: string; secret: KeyPairString };
    return { account: k.account, publicKey: KeyPair.fromString(k.secret).getPublicKey().toString() };
  } catch {
    return null;
  }
})();
const noop = () => () => {};

type Action = { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } };
interface Wallet {
  manifest?: { features?: { signDelegateActions?: boolean } };
  getAccounts(): Promise<{ accountId: string }[]>;
  signDelegateActions(p: { network?: string; signerId?: string; delegateActions: { receiverId: string; actions: Action[] }[] }): Promise<{ signedDelegateActions: string[] }>;
  signAndSendTransaction(p: { network?: string; signerId?: string; receiverId: string; actions: Action[] }): Promise<unknown>;
}

/**
 * A council member votes on a DAO proposal with their own NEAR wallet. No key is stored in this browser: the wallet
 * signs. If it can sign a NEP-366 delegate action, the vote is gasless (the app's relayer submits it and pays the gas,
 * relaying only one `act_proposal` on this DAO from a council member); otherwise the wallet sends the vote itself.
 */
export function GaslessVote({ dao, proposalId, kind, network, relayer, paymentId }: { dao: string; proposalId: number; kind: unknown; rpcUrl: string; network: "mainnet" | "testnet"; relayer: boolean; paymentId: string }) {
  const wallet = useRef<Wallet | null>(null);
  const [account, setAccount] = useState("");
  const [gasless, setGasless] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { run, error } = useAction();

  const oldKey = useSyncExternalStore(noop, () => LEGACY, () => null);

  const withAction = (action: "VoteApprove" | "VoteReject"): Action[] => [
    { type: "FunctionCall", params: { methodName: "act_proposal", args: { id: proposalId, action, proposal: kind }, gas: "300000000000000", deposit: "0" } },
  ];

  async function connect() {
    setErr(null);
    setBusy(true);
    try {
      const { NearConnector } = await import("@hot-labs/near-connect");
      const w = (await new NearConnector({ network }).connect()) as unknown as Wallet;
      const [first] = await w.getAccounts();
      if (!first) throw new Error("The wallet returned no account.");
      wallet.current = w;
      setAccount(first.accountId);
      // Gasless only with a relayer configured and a wallet that can sign delegate actions.
      setGasless(relayer && !!w.manifest?.features?.signDelegateActions);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cast(action: "VoteApprove" | "VoteReject", withGas = false) {
    const w = wallet.current;
    if (!w) return;
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      if (gasless && !withGas) {
        const { signedDelegateActions } = await w.signDelegateActions({ network, signerId: account, delegateActions: [{ receiverId: dao, actions: withAction(action) }] });
        const out = await run<{ txHash: string }>("/api/relay", { signedDelegate: signedDelegateActions[0], paymentId });
        if (out) setMsg(`Vote sent by the relayer${out.txHash ? ` (tx ${out.txHash})` : ""}. You paid no gas.`);
      } else {
        await w.signAndSendTransaction({ network, signerId: account, receiverId: dao, actions: withAction(action) });
        setMsg("Vote sent from your wallet.");
      }
    } catch (e) {
      setErr(`The vote was not sent: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-2">
      {oldKey && (
        <div role="alert" className="text-sm" style={{ color: "var(--amber)" }}>
          This browser held a voting key from an earlier version, readable by any script on the page. It has been deleted here.
          Remove it from <span className="mono">{oldKey.account}</span> as well:
          <pre className="mono mt-1 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-xs" style={{ background: "var(--bg-2)", color: "var(--tx-1)" }}>
            {`near account delete-keys ${oldKey.account} public-keys ${oldKey.publicKey} network-config ${network} sign-with-keychain send`}
          </pre>
        </div>
      )}
      {!account ? (
        <>
          <p className="text-sm" style={{ color: "var(--tx-1)" }}>Council members can vote here with their own NEAR wallet. No key is kept in this browser.</p>
          <div><button className="btn btn-secondary btn-sm" disabled={busy} onClick={connect}>{busy ? "Opening wallet…" : "Connect wallet to vote"}</button></div>
        </>
      ) : (
        <>
          <p className="text-sm" style={{ color: "var(--tx-1)" }}>
            Voting as <span className="mono">{account}</span>{gasless ? " — gasless: your wallet signs, the relayer pays the gas." : " — your wallet sends the vote (a tiny amount of gas)."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => cast("VoteApprove")}>{busy ? "Waiting for your wallet…" : `Approve #${proposalId}`}</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => cast("VoteReject")}>Reject</button>
            {gasless && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => cast("VoteApprove", true)}>Approve, paying gas myself</button>}
          </div>
        </>
      )}
      {msg && <p className="text-sm pos">{msg}</p>}
      <ErrorLine msg={err ?? error} />
    </div>
  );
}
