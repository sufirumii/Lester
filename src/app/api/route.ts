/**
 * The single Lester API route file (v1.0.4) — one plain, bracket-free path for
 * the whole /api tree.
 *
 * v1.0.2 served this tree as an optional catch-all
 * (`src/app/api/[[...route]]/route.ts`), but GitHub's *web* uploader cannot
 * process file paths containing `[` or `]`: it fails with "Something went
 * really wrong, and we can't process that file" and silently drops every file
 * queued after it — which is how partial repository uploads kept happening.
 * Explicit per-endpoint route directories would need the same bracket names
 * (`[id]`), so instead the whole tree funnels through this one file: the
 * rewrite in `next.config.ts` maps every `/api/*` URL onto this route for
 * matching, while the Request handed to it still carries the original URL.
 * This file rebuilds the exact `params` object the catch-all used to receive
 * (the sub-path, split and percent-decoded per segment) and hands it to the
 * unchanged method+path router in ./handlers.ts — same URLs, methods, status
 * codes, cookies, streaming and auth rules.
 *
 * maxDuration is the chat pipeline's 300s cap (inert for self-hosted).
 */
import { handleApi } from "./handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ route?: string[] }> };

/**
 * Catch-all-equivalent params, rebuilt from the original request path.
 * `/api` itself (and an empty sub-path) yields no segments — the optional
 * catch-all's zero-segment case, which dispatches to the 404 shape.
 */
function routeCtx(req: Request): Ctx {
  const { pathname } = new URL(req.url);
  const sub = pathname.slice("/api/".length);
  if (!sub || sub === "/") return { params: Promise.resolve({}) };
  const route = sub
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // a lone '%' etc. — pass through undecoded
      }
    });
  return { params: Promise.resolve({ route }) };
}

export function GET(req: Request) {
  return handleApi(req, routeCtx(req));
}
export function POST(req: Request) {
  return handleApi(req, routeCtx(req));
}
export function PUT(req: Request) {
  return handleApi(req, routeCtx(req));
}
export function PATCH(req: Request) {
  return handleApi(req, routeCtx(req));
}
export function DELETE(req: Request) {
  return handleApi(req, routeCtx(req));
}
