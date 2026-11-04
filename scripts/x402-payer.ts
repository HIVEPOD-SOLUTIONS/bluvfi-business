/**
 * `npm run x402:payer -- <step>`: the payer service the agent's x402 spending needs (X402_PAYER_URL). It holds a small wallet, because
 * the app itself holds no payment key, and signs payments for the app within hard limits.
 *
 *   setup [--mainnet]   make the wallet (once) and print its address and how to fund it
 *   status [--mainnet]  its address, its USDC balance and what it has spent today
 *   serve [--mainnet]   run the service on 127.0.0.1:4020 (X402_PAYER_PORT)
 *
 * Testnet by default: it signs only for Base Sepolia, where USDC is free, so nothing real can be spent. --mainnet signs only for Base
 * mainnet. Limits: X402_PAYER_MAX_USD per payment (default 0.05) and X402_PAYER_MAX_DAY_USD per day (default 1).
 * The key and the shared secret are kept in .testnet/ or .mainnet/ (both git-ignored); the secret is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

async function main() {
  const args = process.argv.slice(2);
  const step = args[0];
  const mainnet = args.includes("--mainnet");
  const dir = mainnet ? ".mainnet" : ".testnet";
  const file = `${dir}/x402-payer.json`;
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { randomBytes } = await import("node:crypto");
  const { createPayer } = await import("../lib/x402-payer");
  const rpc = mainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
  const usdc = mainnet ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  if (!step) return console.log("Steps: setup, status, serve. Add --mainnet for real money. See the top of this file.");
  if (step === "setup" && !existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ privateKey: generatePrivateKey(), token: randomBytes(24).toString("hex") }, null, 2));
    console.log(`Made the payer's wallet (kept in ${file}, which git ignores).`);
  }
  if (!existsSync(file)) throw new Error(`Run \`npm run x402:payer -- setup${mainnet ? " --mainnet" : ""}\` first.`);
  const { privateKey, token } = JSON.parse(readFileSync(file, "utf8")) as { privateKey: `0x${string}`; token: string };
  const address = privateKeyToAccount(privateKey).address;
  const port = Number(process.env.X402_PAYER_PORT ?? 4020);

  const balance = async () => {
    const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdc, data }, "latest"] }) });
    const j = (await r.json()) as { result?: string };
    return Number(BigInt(j.result ?? "0x0")) / 1e6;
  };
  const payer = createPayer({
    privateKey, token, testnet: !mainnet,
    maxPaymentUsd: Number(process.env.X402_PAYER_MAX_USD ?? 0.05),
    maxDayUsd: Number(process.env.X402_PAYER_MAX_DAY_USD ?? 1),
    spentFile: `${dir}/x402-payer-spent.json`,
  });

  if (step === "setup") {
    console.log(`\nPayer wallet (${mainnet ? "Base mainnet" : "Base Sepolia, test money"}): ${address}\n`);
    console.log(mainnet
      ? "Fund it with a few dollars of USDC on Base (no ETH needed: the API's facilitator pays the gas). Keep it small: it is the most this payer can ever lose."
      : "Get free test USDC for it: https://faucet.circle.com, choose Base Sepolia and USDC, paste the address above. No ETH is needed.");
    console.log(`\nThen put these in .env.local (the secret is in ${file}, under "token"):\n  X402_PAYER_URL=http://127.0.0.1:${port}\n  X402_PAYER_TOKEN=<the token from ${file}>${mainnet ? "" : "\n  X402_TESTNET=1"}\nand run: npm run x402:payer -- serve${mainnet ? " --mainnet" : ""}\n`);
    return;
  }
  if (step === "status") {
    console.log(`\nPayer ${address} (${mainnet ? "Base mainnet" : "Base Sepolia"})\n  USDC balance: ${(await balance().catch(() => NaN)).toFixed(6)}\n  Spent today:  $${payer.spentToday()}\n`);
    return;
  }
  if (step === "serve") {
    const server = createServer((req, res) => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
      if (req.method !== "POST" || req.url !== "/pay") return send(404, { error: "Not found" });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "Not JSON" }); }
        const out = await payer.pay(body, req.headers.authorization);
        console.log(`${new Date().toISOString().slice(11, 19)}  ${out.status}  ${out.body.error ?? `signed $${out.body.usd}`}`);
        send(out.status, out.body);
      });
    });
    server.listen(port, "127.0.0.1", () => console.log(`Payer ${address} (${mainnet ? "Base mainnet, REAL money" : "Base Sepolia, test money"}) listening on 127.0.0.1:${port}. Ctrl+C to stop.`));
    return;
  }
  throw new Error(`Unknown step "${step}".`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
