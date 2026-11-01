"use client";
import { Account, JsonRpcProvider, KeyPair, actions, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ErrorLine, useAction } from "./Actions";

const STORE = "bluvfi.voteKey";
interface VoteKey { account: string; secret: KeyPairString }

// The voting key lives in this browser only. Read through useSyncExternalStore so the server render (no key) and the
// browser agree, and every vote panel on the page sees a change.
const read = () => {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
};
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
const save = (k: VoteKey | null) => {
  try {
    if (k) localStorage.setItem(STORE, JSON.stringify(k));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage blocked: the key lives only until reload */
  }
  window.dispatchEvent(new StorageEvent("storage", { key: STORE }));
};

/**
 * A council member votes on a DAO proposal without holding NEAR for gas. Their browser keeps a key that may only
 * call `act_proposal` on the DAO (added once to their own account), signs a NEP-366 delegate action with it, and
 * the app's relayer submits it and pays the gas. The key never leaves this browser and cannot move funds.
 */
export function GaslessVote({ dao, proposalId, kind, rpcUrl, paymentId }: { dao: string; proposalId: number; kind: unknown; rpcUrl: string; paymentId: string }) {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const key = useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as VoteKey) : null;
    } catch {
      return null;
    }
  }, [raw]);
  const [account, setAccount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, error } = useAction();
  const pub = key ? KeyPair.fromString(key.secret).getPublicKey().toString() : "";

  async function vote(action: "VoteApprove" | "VoteReject") {
    if (!key) return;
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const voter = new Account(key.account, new JsonRpcProvider({ url: rpcUrl }), key.secret);
      const { signedDelegate } = await voter.createSignedMetaTransaction({
        receiverId: dao,
        blockHeightTtl: 120,
        actions: [actions.functionCall("act_proposal", { id: proposalId, action, proposal: kind }, teraToGas(300), BigInt(0))],
      });
      const b64 = btoa(String.fromCharCode(...encodeSignedDelegate(signedDelegate)));
      const out = await run<{ txHash: string }>("/api/relay", { signedDelegate: b64, paymentId });
      if (out) setMsg(`Vote sent by the relayer${out.txHash ? ` (tx ${out.txHash})` : ""}. You paid no gas.`);
    } catch (e) {
      setErr(`Could not sign the vote: ${(e as Error).message}. Is the voting key added to ${key.account}?`);
    } finally {
      setBusy(false);
    }
  }

  if (!key)
    return (
      <form
        className="mt-3 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const k: VoteKey = { account: account.trim(), secret: KeyPair.fromRandom("ed25519").toString() as KeyPairString };
          save(k);
        }}
      >
        <p className="text-sm" style={{ color: "var(--tx-1)" }}>Vote here without gas: create a voting key in this browser, then add it once to your NEAR account. It can only vote on this DAO.</p>
        <div className="flex flex-wrap gap-2">
          <input className="input min-w-0 flex-1" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="your-account.near (a council member)" aria-label="Your NEAR account" />
          <button className="btn btn-secondary" disabled={!/\.near$|^[0-9a-f]{64}$/.test(account.trim())}>Create voting key</button>
        </div>
      </form>
    );

  return (
    <div className="mt-3 grid gap-2">
      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
        Voting as <span className="mono">{key.account}</span>. If you have not yet, add this browser&apos;s key to your account once (it may only call <span className="mono">act_proposal</span> on {dao}):
      </p>
      <pre className="mono overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: "var(--bg-2)" }}>
        {`near account add-key ${key.account} grant-function-call-access --allowance '0.25 NEAR' --contract-account-id ${dao} --function-names act_proposal use-manually-provided-public-key ${pub} network-config mainnet sign-with-keychain send`}
      </pre>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => vote("VoteApprove")}>{busy ? "Signing…" : `Approve #${proposalId} (gasless)`}</button>
        <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => vote("VoteReject")}>Reject</button>
        <button className="btn btn-ghost btn-sm" onClick={() => save(null)}>Forget this key</button>
      </div>
      {msg && <p className="text-sm pos">{msg}</p>}
      <ErrorLine msg={err ?? error} />
    </div>
  );
}
