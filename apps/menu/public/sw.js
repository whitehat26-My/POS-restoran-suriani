/**
 * Offline shell for the customer menu.
 *
 * - Build assets: cache-first (they are content-hashed, so never stale).
 * - Navigations: network-first, falling back to the cached shell, so losing
 *   signal mid-meal does not blank the page.
 * - Menu data (GET /api/t/...): network-first with cache fallback — fresh
 *   when online, last-known-good when not.
 *
 * Order submission is deliberately NOT intercepted: the cart already survives
 * in localStorage and the ULID makes retries safe. A background-sync queue can
 * come later; a half-visible one would be worse than none.
 */
const SHELL = "suriani-shell-v1";
const DATA = "suriani-menu-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL && k !== DATA)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Menu data: network first, cache fallback.
  if (url.pathname.startsWith("/api/t/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Other API calls are never cached.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network first, cached shell as the offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/__shell", copy));
          return res;
        })
        .catch(() =>
          caches.match("/__shell").then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }

  // Hashed build assets: cache first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith("/assets/")) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
