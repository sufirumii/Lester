/* Lester service worker — installable PWA shell.
   Deliberately conservative: caches only the app shell and static brand
   assets. API traffic is NEVER cached or intercepted beyond pass-through,
   so policy, streaming and the Proof ledger always hit the live server. */

const CACHE = "lester-shell-v1";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Never touch API traffic.
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for the shell (fresh UI when online, cache fallback offline).
  if (url.pathname === "/" || SHELL.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit ?? Response.error()))
    );
    return;
  }

  // Everything else: plain pass-through.
});
