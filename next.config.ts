import type { NextConfig } from "next";

/**
 * Security headers on every response. This app moves money, so no other site may frame it (clickjacking a signer into
 * clicking "approve"), browsers must not guess content types, and links out do not leak full URLs (pay links carry ids).
 * The CSP sets only what cannot break the wallet widgets (Privy, HOT, WalletConnect, Aurora load scripts and frames of their
 * own): who may frame us, where forms may post, no plugins, no <base> rewriting.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  // Pure-JS DCAP verifier: keep it out of the bundle so its dynamic requires work.
  // o1js loads WebAssembly and worker threads from its own files, so it must not be bundled either.
  serverExternalPackages: ["@phala/dcap-qvl", "o1js"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    // Browser setup (lib/setup.ts) writes .env.local at the project root, so Turbopack warns that it traces the whole
    // project. That only matters for `output: "standalone"`, which this app does not use (the Dockerfile copies it all).
    ignoreIssue: [
      { path: "**/lib/setup.ts", title: /Dynamic filesystem access/ },
      { path: "**/lib/wallets.ts", title: /Dynamic filesystem access/ }, // the operator's wallet key files, also under the project
      { path: "**/lib/store.ts", title: /Dynamic filesystem access/ }, // the records in the data folder (BLUVFI_DATA_FILE)
      { path: "**/lib/backup.ts", title: /Dynamic filesystem access/ }, // backups read the data folder and write BLUVFI_BACKUP_DIR
    ],
  },
};

export default nextConfig;
