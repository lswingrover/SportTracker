// Service worker for 208 Tracker Web Push.
// Receives `push` events from the browser's push service and surfaces them
// as native OS notifications. Click → focus or open the app.

self.addEventListener("install", (event) => {
  // Take control on first install without forcing a reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
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
