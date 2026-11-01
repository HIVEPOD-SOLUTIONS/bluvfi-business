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
  },
};

export default nextConfig;
