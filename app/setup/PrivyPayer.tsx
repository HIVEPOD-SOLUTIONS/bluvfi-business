"use client";
import { useEffect, useRef, useState } from "react";
import { PrivyProvider, useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { Account, JsonRpcProvider, PublicKey, Signer, actions } from "near-api-js";
import type { SetupPlan } from "@/lib/setup";

/**
 * Pay for setup with email or Google instead of a NEAR wallet: Privy logs the person in and keeps a NEAR wallet for
 * them in its embedded wallet, which signs each transaction hash (signRawHash). Adapted from NEAR's Privy guide
 * (near-examples/hello-privy). The key stays with Privy; neither this page nor the server ever sees it.
 */
export interface Payer {
  accountId: string;
  label: string;
  send(transactions: SetupPlan["transactions"]): Promise<void>;
}

type SignRawHash = ReturnType<typeof useSignRawHash>["signRawHash"];
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A near-api-js signer backed by Privy's embedded wallet. Privy NEAR wallets are implicit accounts: the address is the key. */
class PrivySigner extends Signer {
  constructor(private signRawHash: SignRawHash, private accountId: string, private provider: JsonRpcProvider) {
    super();
  }
  async getPublicKey() {
    if (/^[0-9a-f]{64}$/i.test(this.accountId)) return new PublicKey({ keyType: 0, data: hexToBytes(this.accountId) });
    const { keys } = await new Account(this.accountId, this.provider).getAccessKeyList();
    if (!keys.length) throw new Error("This NEAR account has no access key.");
    return PublicKey.fromString(keys[0].public_key);
  }
  protected async signBytes(bytes: Uint8Array) {
    const { signature } = await this.signRawHash({ address: this.accountId, chainType: "near", hash: `0x${bytesToHex(bytes)}` });
    return hexToBytes(signature);
  }
}

export function PrivyPayerButton(props: { appId: string; network: "mainnet" | "testnet"; rpcUrl: string; needNear: number; onReady(p: Payer | null): void }) {
  return (
    <PrivyProvider appId={props.appId} config={{ loginMethods: ["email", "google", "github"], appearance: { theme: "dark", accentColor: "#0a0ae8" } }}>
      <PrivyNear {...props} />
    </PrivyProvider>
  );
}

function PrivyNear({ network, rpcUrl, needNear, onReady }: { network: "mainnet" | "testnet"; rpcUrl: string; needNear: number; onReady(p: Payer | null): void }) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const [balance, setBalance] = useState<number | null>(null);
  const creating = useRef(false);
  const [error, setError] = useState("");

  const wallet = user?.linkedAccounts.find((a) => a.type === "wallet" && "chainType" in a && a.chainType === "near") as { address: string } | undefined;
  const address = wallet?.address ?? "";

  // A logged-in user without a NEAR wallet gets one, once.
  useEffect(() => {
    if (!authenticated || !user || address || creating.current) return;
    creating.current = true;
    createWallet({ chainType: "near" }).catch((e) => setError(`Could not create a NEAR wallet: ${(e as Error).message}`)).finally(() => { creating.current = false; });
  }, [authenticated, user, address, createWallet]);

  // The wallet's balance: an implicit account only exists on chain once it has been funded.
  useEffect(() => {
    if (!address) return;
    let stop = false;
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const read = () => provider.query({ request_type: "view_account", finality: "final", account_id: address })
      .then((r) => !stop && setBalance(Number(BigInt((r as unknown as { amount: string }).amount) / BigInt(1e18)) / 1e6))
      .catch(() => !stop && setBalance(0));
    read();
    const t = setInterval(read, 10_000);
    return () => { stop = true; clearInterval(t); };
  }, [address, rpcUrl]);

  useEffect(() => {
    if (!address) return onReady(null);
    const provider = new JsonRpcProvider({ url: rpcUrl });
    const account = new Account(address, provider, new PrivySigner(signRawHash, address, provider));
    onReady({
      accountId: address,
      label: user?.google?.email ?? user?.email?.address ?? user?.github?.username ?? "Privy",
      async send(transactions) {
        for (const tx of transactions) {
          await account.signAndSendTransaction({
            receiverId: tx.receiverId,
            actions: tx.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
          });
        }
      },
    });
  }, [address, rpcUrl, signRawHash, user, onReady]);

  if (!ready) return <span className="text-sm" style={{ color: "var(--tx-2)" }}>Loading sign-in…</span>;
  if (!authenticated) return <button className="btn btn-secondary" onClick={() => login()}>Continue with email or Google</button>;
  return (
    <div className="grid gap-1 text-sm">
      {address ? (
        <>
          <span className="pos">✓ Signed in with Privy as {user?.google?.email ?? user?.email?.address ?? user?.github?.username ?? "you"}</span>
          <span>Your NEAR {network} wallet: <span className="mono break-all">{address}</span></span>
          <span>Balance: {balance === null ? "…" : `${balance.toFixed(2)} NEAR`}
            {balance !== null && balance < needNear && (
              <span style={{ color: "var(--amber)" }}> · send at least {needNear} NEAR to this address{network === "testnet" ? " (free from a testnet faucet)" : ""} to pay for setup. It updates every 10 seconds.</span>
            )}
          </span>
        </>
      ) : (
        <span>Creating your NEAR wallet…</span>
      )}
      <button className="btn btn-ghost btn-sm justify-self-start" onClick={() => logout()}>Sign out of Privy</button>
      {error && <span className="neg">{error}</span>}
    </div>
  );
}
