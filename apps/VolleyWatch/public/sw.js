// Service worker for 208 Tracker Web Push.
// Receives `push` events from the browser's push service and surfaces them
// as native OS notifications. Click → focus or open the app.

self.addEventListener("install", (event) => {
  // Take control on first install without forcing a reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        for (const c of clients) c.postMessage({ type: "SW_UPDATED" });
      })
    )
  );
});

// Network-first for page navigation. Falls back to cache only if offline.
// Prevents iOS from serving a stale app shell after a Vercel deploy.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
  // Non-navigation requests (JS, CSS, API, fonts): browser handles normally.
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "208 Tracker", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "208 Tracker";
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
