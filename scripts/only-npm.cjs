// Runs before every install. This project is installed with npm only: package-lock.json pins every version, and the
// "overrides" in package.json (patched ws, protobufjs and others) are an npm feature. Yarn and pnpm ignore both, resolve a
// different tree and break the build (for example mismatched @solana/* packages pulled in by Privy).
const agent = process.env.npm_config_user_agent || "";
if (agent && !agent.startsWith("npm/")) {
  const tool = agent.split("/")[0];
  console.error(`\nThis project is installed with npm, not ${tool}. Run:\n\n  npm ci\n\nthen npm run dev (or npm run demo:ui). See README, "Try it".\n`);
  process.exit(1);
}
