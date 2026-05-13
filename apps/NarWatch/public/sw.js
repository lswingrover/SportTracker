// Service worker for NarWatch.
//
// FETCH STRATEGIES:
//
//   Navigation (HTML):
//     Network-first → cache fallback. Required on iOS PWA to prevent the OS
//     from serving a stale app shell after a Vercel deploy. The existing
//     SW_UPDATED broadcast + reload flow handles invalidation on new deploys.
//
//   Next.js static assets (/_next/static/**):
//     Cache-first → network fallback. These URLs contain a content hash so
//     they are immutable for a given deploy. Safe to serve from cache forever;
//     the browser's own Cache-Control: immutable header already does this, but
//     the SW layer adds offline resilience.
//
//   API responses (/api/**):
//     Network-first → cache fallback (offline resilience). Fresh TTL: 90s.
//     Stale-while-revalidate semantics are handled client-side; SW only
//     provides offline coverage so the last-known data renders when the network
//     is unavailable.
//
//   Everything else (fonts, icons, push, etc.):
//     Pass-through — browser handles normally.
//
// Cache names are versioned. Activate step purges any cache whose name starts
// with "narwatch-" but is not in CURRENT_CACHES.
//
// GH#12.

const SHELL_CACHE  = "narwatch-shell-v1";
const STATIC_CACHE = "narwatch-static-v1";
const API_CACHE    = "narwatch-api-v1";

const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE, API_CACHE]);

// API responses stay "fresh" in SW cache for this long before a network
// re-fetch is preferred. Client-side cache (localStorage SWR) handles
// sub-TTL freshness; SW layer is purely for offline resilience.
const API_CACHE_TTL_MS = 90 * 1000;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  // Take control immediately — don't wait for old SW to idle.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // 1. Purge stale versioned caches.
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("narwatch-") && !CURRENT_CACHES.has(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
      .then(() =>
        // 2. Notify all open tabs to reload so they get the new HTML + bundles.
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          for (const c of clients) c.postMessage({ type: "SW_UPDATED" });
        })
      )
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // ── Next.js static assets — cache-first (immutable, content-hashed) ───────
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // ── API responses — network-first, cache fallback ─────────────────────────
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // ── HTML navigation — network-first, cache fallback ───────────────────────
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNav(request));
    return;
  }

  // Everything else: pass through.
});

// ── Strategy helpers ──────────────────────────────────────────────────────────

/** Cache-first: serve from cache, fall back to network and populate cache. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

/**
 * Network-first for HTML navigation.
 * Caches the latest successful response for offline fallback.
 * Skips caching redirects and opaque responses.
 */
async function networkFirstNav(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

/**
 * Network-first for API routes with TTL-based freshness and cache fallback.
 * - If a cached response exists and is fresher than API_CACHE_TTL_MS, use it.
 * - Otherwise try network; on success update cache.
 * - On network failure, return cached response regardless of age (offline resilience).
 */
async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);

  // Check cache freshness via the X-SW-Cached-At header we stamp on writes.
  const cached = await cache.match(request);
  if (cached) {
    const cachedAt = Number(cached.headers.get("X-SW-Cached-At") || 0);
    if (Date.now() - cachedAt < API_CACHE_TTL_MS) {
      return cached; // fresh enough — serve from cache
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Stamp our freshness header before storing.
      const stamped = stampResponse(response.clone());
      cache.put(request, stamped);
    }
    return response;
  } catch {
    // Network failed — serve stale cache if available (offline resilience).
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: "offline", cached: false }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Clone a response, injecting X-SW-Cached-At: <epoch ms> into headers.
 * Required because Response headers are immutable after creation.
 */
async function stampResponse(response) {
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("X-SW-Cached-At", String(Date.now()));
  return new Response(body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "NarWatch", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "NarWatch";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: data.url || "/" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.endsWith(targetUrl) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return null;
    })
  );
});
