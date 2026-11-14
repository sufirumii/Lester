import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next 16.4 `proxy` convention (formerly middleware.ts — the file name and
 * exported function name changed; behavior is identical).
 *
 * S1 — request protection:
 *   1. Origin check on state-changing requests to cookie-authenticated API
 *      routes (CSRF). /api/v1/* uses Bearer tokens only (no cookies → no CSRF
 *      surface) and is explicitly exempt so OpenAI SDKs work without Origin.
 *   2. Security headers on every response: CSP, frame-ancestors 'none',
 *      nosniff, no-referrer, minimal Permissions-Policy.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isCookieAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/v1/");
}

function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (STATE_CHANGING.has(method) && isCookieAuthRoute(pathname)) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    // Same-origin browsers always send Origin on cross-site state-changing
    // requests and on same-origin fetch()/XHR. Absent Origin (curl, scripts,
    // tests) is allowed — authentication still applies.
    if (origin && !sameOrigin(origin, host)) {
      return NextResponse.json(
        { error: { code: "bad_origin", message: `Cross-origin ${method} requests to the Lester API are refused (Origin: ${origin}).` } },
        { status: 403, headers: securityHeaders() }
      );
    }
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
  return res;
}

export function securityHeaders(): Record<string, string> {
  return {
    // 'unsafe-inline' styles are required by Next's styled-jsx/Tailwind inline
    // styles; scripts are self-only. react-markdown renders no raw HTML.
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.svg|icons/|manifest\\.webmanifest|sw\\.js).*)"],
};
