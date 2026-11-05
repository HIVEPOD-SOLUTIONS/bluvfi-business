import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ],
  },
};

export default nextConfig;
