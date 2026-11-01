import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure-JS DCAP verifier; keep it out of the bundle so its dynamic requires work.
  serverExternalPackages: ["@phala/dcap-qvl"],
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
