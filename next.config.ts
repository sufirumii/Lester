import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // B6 — no ignored type errors; `bunx tsc --noEmit` and `next build` must both pass.
  typescript: {
    ignoreBuildErrors: false,
  },
  // A9 — strict mode on; what it reveals gets fixed, not hidden.
  reactStrictMode: true,
};

export default nextConfig;
