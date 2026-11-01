/**
 * `npm run demo:ui`: seeds the demo story into .data/demo.json and starts the web app in demo mode on
 * http://localhost:3000 (`next dev`). `npm run demo:serve` does the same with `next start`, for a hosted demo
 * (run `npm run build` first; the Dockerfile does). Acme's callback is left pending, so you can click "Vendor said not us" yourself.
 * Sign in with the token demo-signer-maya-token.
 */
import { spawn } from "node:child_process";

process.env.BLUVFI_DEMO = "1";
process.env.BLUVFI_DATA_FILE = ".data/demo.json";

async function main() {
  const { runDemo } = await import("../lib/demo-scenario");
  const { persist } = await import("../lib/store");
  await runDemo({ vendorReplies: false });
  persist();
  const prod = process.argv.includes("--prod");
  const port = process.argv.slice(2).find((a) => /^d+$/.test(a)) ?? process.env.PORT ?? "3000";
  console.log(`Demo data written to .data/demo.json. Starting the app on http://localhost:${port} (sign in with demo-signer-maya-token).`);
  const child = spawn("npx", ["next", prod ? "start" : "dev", "-p", port], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
