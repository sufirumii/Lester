import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // B6 — no ignored type errors; `bunx tsc --noEmit` and `next build` must both pass.
  typescript: {
    ignoreBuildErrors: false,
  },
  // A9 — strict mode on; what it reveals gets fixed, not hidden.
  reactStrictMode: true,
  // v1.0.4 — bracket-free API routing. GitHub's *web* uploader cannot process
  // paths containing `[` or `]` (it fails with "Something went really wrong,
  // and we can't process that file" and silently drops every file queued
  // after it), so the repository cannot ship `src/app/api/[[...route]]/` or
  // `[id]/` directories. The whole /api tree is instead served by one plain
  // route file — `src/app/api/route.ts` — and this rewrite maps every
  // `/api/*` URL onto it for routing while the route handler still receives
  // the original request URL, from which it rebuilds the exact `params` the
  // optional catch-all used to provide (see route.ts). Dispatch is the
  // unchanged method+path router in `src/app/api/handlers.ts`; URLs, methods,
  // bodies, cookies, query strings, status codes and SSE are untouched.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "/api" }];
  },
};

export default nextConfig;
