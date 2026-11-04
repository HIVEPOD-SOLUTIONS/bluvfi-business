/**
 * `npm run confidential:test -- <step>`: a small, real, funded test of a confidential payout on NEAR mainnet, with a throwaway account.
 * Nothing here involves your treasury or a DAO. The account's key is made here and kept in .mainnet/confidential-test.json (git-ignored),
 * so only what you send to it is ever at risk. Every step that moves money refuses more than $5 unless you pass --max <usd>.
 *
 *   setup              make the throwaway account and print its address and what it holds
 *   status             what the account holds: NEAR, USDC, the public Intents balance, the shielded balance
 *   register           give the account a USDC storage slot (needs about 0.002 NEAR sent first); skip if your wallet did it when you sent USDC
 *   deposit <usdc>     move USDC from the account into its public Intents balance (intents.near)
 *   shield <usdc>      move USDC from its public Intents balance into its confidential balance (1:1, no fee)
 *   pay <usd> <chain> <address>   pay out of the confidential balance to an address (chain: near, eth, base, arb, sol), then follow it to the end
 *
 * Needs ONECLICK_JWT (your 1Click partner key) in .env.local.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FILE = ".mainnet/confidential-test.json";

async function main() {
  // The partner key lives in .env.local; scripts do not load it on their own.
  if (!process.env.ONECLICK_JWT && existsSync(".env.local")) {
    const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("ONECLICK_JWT="));
    const key = line?.slice("ONECLICK_JWT=".length).trim();
    if (key) process.env.ONECLICK_JWT = key;
  }
  const [step, ...rest] = process.argv.slice(2);
  const maxFlag = rest.indexOf("--max");
  const max = maxFlag >= 0 ? Number(rest.splice(maxFlag, 2)[1]) : 5;
  if (!step) return console.log("Steps: setup, status, register, deposit <usdc>, shield <usdc>, pay <usd> <chain> <address>. See the top of this file.");

  const { Account, JsonRpcProvider, KeyPair, keyToImplicitAddress, nearToYocto, teraToGas } = await import("near-api-js");
  type KeyPairString = Parameters<typeof KeyPair.fromString>[0];
  const { ASSET_ID, NEAR_USDC_CONTRACT } = await import("../lib/chains");
  const c = await import("../lib/confidential");
  const { viewFn } = await import("../lib/custody");
  const { NEAR_RPC_URL } = await import("../lib/config");

  if (step === "setup" && !existsSync(FILE)) {
    mkdirSync(".mainnet", { recursive: true });
    const key = KeyPair.fromRandom("ed25519");
    writeFileSync(FILE, JSON.stringify({ accountId: keyToImplicitAddress(key.getPublicKey().toString()), secret: key.toString() }, null, 2));
    console.log("Made a throwaway account (its key is in .mainnet/confidential-test.json, which git ignores).");
  }
  if (!existsSync(FILE)) throw new Error("Run `npm run confidential:test -- setup` first.");
  const { accountId, secret } = JSON.parse(readFileSync(FILE, "utf8")) as { accountId: string; secret: string };
  const key = KeyPair.fromString(secret as KeyPairString);
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const account = new Account(accountId, provider, secret as KeyPairString);
  const USDC = ASSET_ID["near:USDC"];
  const usdc = (raw: string) => (Number(BigInt(raw)) / 1e6).toFixed(6);
  const toRaw = (usd: number) => BigInt(Math.round(usd * 1e6)).toString();
  const guard = (usd: number) => {
    if (!(usd > 0)) throw new Error("Give an amount above zero.");
    if (usd > max) throw new Error(`$${usd} is over the $${max} limit for this test account. Pass --max <usd> if you mean it.`);
  };
  const session = async () => (await c.loginWithKey(accountId, key)).accessToken;

  const balances = async () => {
    const near = await provider.query({ request_type: "view_account", finality: "final", account_id: accountId }).then((r) => `${(Number(BigInt((r as unknown as { amount: string }).amount) / BigInt(1e18)) / 1e6).toFixed(4)} NEAR`).catch(() => "0 NEAR (the account does not exist on chain yet)");
    const wallet = await viewFn<string>(NEAR_USDC_CONTRACT, "ft_balance_of", { account_id: accountId }).then(usdc).catch(() => "0.000000 (not registered for USDC yet)");
    const pub = await viewFn<string>("intents.near", "mt_balance_of", { account_id: accountId, token_id: USDC }).then(usdc).catch(() => "?");
    const shielded = await c.confidentialBalances(await session()).then((b) => b.map((x) => `${x.tokenId.split(":").pop()?.slice(0, 8)}… ${usdc(x.amount)}`).join(", ") || "0.000000").catch((e) => `? (${(e as Error).message.slice(0, 60)})`);
    console.log(`\nAccount ${accountId}\n  NEAR for gas:           ${near}\n  USDC in the account:    ${wallet}\n  Public Intents balance: ${pub}\n  Shielded balance:       ${shielded}\n`);
  };

  /** Follow a confidential swap by its deposit address until it ends. */
  const follow = async (depositAddress: string) => {
    const token = await session();
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await c.confidentialStatus(token, depositAddress);
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${s.status}${s.refunded !== "0" ? `  (refunded ${s.refunded})` : ""}`);
      if (/^(SUCCESS|FAILED|REFUNDED)$/.test(s.status)) return s.status;
    }
    return "TIMED_OUT";
  };

  /** Sign a generated intent with the account's own key and submit it. */
  const signAndSubmit = async (token: string, intent: Awaited<ReturnType<typeof c.generateIntent>>) => {
    const signed = c.signWithKey(key, intent.payload.message, Buffer.from(intent.payload.nonce, "base64"), intent.payload.recipient);
    return c.submitIntent(token, intent, signed.public_key, signed.signature);
  };

  if (step === "setup") {
    console.log(`\nSend to this address, on NEAR mainnet:\n  ${accountId}\n    • about 0.05 NEAR (gas and storage)\n    • about 2 USDC (NEAR-native USDC, contract ${NEAR_USDC_CONTRACT.slice(0, 12)}…)\nThen: npm run confidential:test -- status`);
    return balances();
  }
  if (step === "status") return balances();

  if (step === "register") {
    await account.callFunction({ contractId: NEAR_USDC_CONTRACT, methodName: "storage_deposit", args: { account_id: accountId, registration_only: true }, gas: teraToGas(30), deposit: nearToYocto("0.00125") });
    console.log("Registered for USDC.");
    return balances();
  }
  if (step === "deposit") {
    const usd = Number(rest[0]);
    guard(usd);
    await account.callFunction({ contractId: NEAR_USDC_CONTRACT, methodName: "ft_transfer_call", args: { receiver_id: "intents.near", amount: toRaw(usd), msg: JSON.stringify({ receiver_id: accountId }) }, gas: teraToGas(100), deposit: BigInt(1) });
    console.log(`Deposited $${usd} into the public Intents balance.`);
    return balances();
  }
  if (step === "shield") {
    const usd = Number(rest[0]);
    guard(usd);
    const token = await session();
    const q = await c.shieldQuote(token, { account: accountId, assetId: USDC, amountRaw: toRaw(usd) });
    console.log(`Shield quote: ${q.amountIn} in, ${q.amountOut} shielded.`);
    const hash = await signAndSubmit(token, await c.generateIntent(token, accountId, q.depositAddress));
    console.log(`Submitted (intent ${hash}). Following it:`);
    console.log(`Shield ended: ${await follow(q.depositAddress)}`);
    return balances();
  }
  if (step === "pay") {
    const [usdArg, chain, address] = rest;
    const usd = Number(usdArg);
    guard(usd);
    const destination = ASSET_ID[`${chain}:USDC`];
    if (!destination || !address) throw new Error("Usage: pay <usd> <near|eth|base|arb|sol> <address>");
    const token = await session();
    const q = await c.confidentialQuote(token, { account: accountId, originAsset: USDC, destinationAsset: destination, amountOutRaw: toRaw(usd), recipient: address });
    console.log(`Payout quote: ${q.amountIn} USDC from the shielded balance for ${q.amountOut} USDC to ${address} on ${chain}.`);
    const hash = await signAndSubmit(token, await c.generateIntent(token, accountId, q.depositAddress));
    console.log(`Submitted (intent ${hash}). Following it:`);
    console.log(`Payout ended: ${await follow(q.depositAddress)}`);
    return balances();
  }
  throw new Error(`Unknown step "${step}".`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
