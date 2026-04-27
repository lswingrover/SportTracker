// Server-side Web Push fan-out. web-push handles VAPID JWT signing and the
// FCM/APNs/Mozilla endpoint protocol. Subscriptions live in Blob storage
// keyed by team.

import { readJson, writeJson, blobConfigured } from "./blobStore.js";

let _webpush = null;
async function getWebPush() {
  if (_webpush) return _webpush;
  try {
    const mod = await import("web-push");
    const wp = mod.default || mod;
    if (process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      wp.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:noreply@example.com",
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    }
    _webpush = wp;
    return wp;
  } catch {
    return null;
  }
}

export function pushConfigured() {
  return (
    Boolean(process.env.VAPID_PRIVATE_KEY) &&
    Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) &&
    blobConfigured()
  );
}

const subsKey = (teamId) => `push-subs-${teamId}.json`;

export async function listSubscriptions(teamId) {
  const data = await readJson(subsKey(teamId), { subs: [] });
  return Array.isArray(data?.subs) ? data.subs : [];
}

export async function addSubscription(teamId, subscription, ua) {
  if (!subscription?.endpoint) return false;
  const subs = await listSubscriptions(teamId);
  const filtered = subs.filter((s) => s.endpoint !== subscription.endpoint);
  filtered.push({
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    ua: (ua || "").slice(0, 200),
    subscribedAt: new Date().toISOString(),
  });
  return writeJson(subsKey(teamId), { subs: filtered });
}

export async function removeSubscription(teamId, endpoint) {
  if (!endpoint) return false;
  const subs = await listSubscriptions(teamId);
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length === subs.length) return true;
  return writeJson(subsKey(teamId), { subs: filtered });
}

// Fire a push notification to every subscriber for a team.
// payload should be { title, body, tag?, url? }. Endpoints that return 410
// (gone) or 404 are pruned automatically.
export async function pushToTeam(teamId, payload) {
  if (!pushConfigured()) return { skipped: "not_configured", sent: 0, failed: 0, removed: 0 };
  const wp = await getWebPush();
  if (!wp) return { skipped: "webpush_unavailable", sent: 0, failed: 0, removed: 0 };
  const subs = await listSubscriptions(teamId);
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0, total: 0 };

  let sent = 0, failed = 0;
  const dead = new Set();
  await Promise.all(
    subs.map(async (s) => {
      try {
        await wp.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify(payload),
          { TTL: 60 * 60 }
        );
        sent++;
      } catch (err) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          dead.add(s.endpoint);
        }
        failed++;
      }
    })
  );

  let removed = 0;
  if (dead.size > 0) {
    const fresh = subs.filter((s) => !dead.has(s.endpoint));
    await writeJson(subsKey(teamId), { subs: fresh });
    removed = dead.size;
  }
  return { sent, failed, removed, total: subs.length };
}
