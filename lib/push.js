// Server-side Web Push fan-out. web-push handles VAPID JWT signing and the
// FCM/APNs/Mozilla endpoint protocol. Subscriptions live in Blob storage
// keyed by team. Each subscription carries per-type prefs so users can
// silence categories they don't care about.

import { readJson, writeJson, blobConfigured } from "./blobStore.js";

// Canonical list of alert types. Add a new entry here, then route a
// `kind` from stateDiff to it, and surface a toggle in NotificationsCard.
export const ALERT_TYPES = [
  "game-soon-30",
  "game-soon-10",
  "live-score",
  "final-result",
  "schedule-change",
  "bracket-advance",
];

export function defaultPrefs() {
  const out = {};
  for (const t of ALERT_TYPES) out[t] = true;
  return out;
}

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

function sanitizePrefs(input) {
  const out = defaultPrefs();
  if (input && typeof input === "object") {
    for (const t of ALERT_TYPES) {
      if (typeof input[t] === "boolean") out[t] = input[t];
    }
  }
  return out;
}

export async function addSubscription(teamId, subscription, ua, prefs) {
  if (!subscription?.endpoint) return false;
  const subs = await listSubscriptions(teamId);
  const existing = subs.find((s) => s.endpoint === subscription.endpoint);
  const filtered = subs.filter((s) => s.endpoint !== subscription.endpoint);
  filtered.push({
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    ua: (ua || "").slice(0, 200),
    prefs: sanitizePrefs(prefs ?? existing?.prefs),
    subscribedAt: existing?.subscribedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return writeJson(subsKey(teamId), { subs: filtered });
}

export async function updatePrefs(teamId, endpoint, prefs) {
  if (!endpoint) return false;
  const subs = await listSubscriptions(teamId);
  let touched = false;
  const next = subs.map((s) => {
    if (s.endpoint !== endpoint) return s;
    touched = true;
    return { ...s, prefs: sanitizePrefs(prefs), updatedAt: new Date().toISOString() };
  });
  if (!touched) return false;
  return writeJson(subsKey(teamId), { subs: next });
}

export async function removeSubscription(teamId, endpoint) {
  if (!endpoint) return false;
  const subs = await listSubscriptions(teamId);
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length === subs.length) return true;
  return writeJson(subsKey(teamId), { subs: filtered });
}

// Fire a push notification to every subscriber for a team.
// payload: { title, body, tag?, url? }
// kind: an ALERT_TYPES entry; subscribers with prefs[kind] === false are
// skipped. Pass null/undefined to bypass filtering (admin sends).
// Endpoints that return 404/410 are pruned automatically.
export async function pushToTeam(teamId, payload, kind = null) {
  if (!pushConfigured()) return { skipped: "not_configured", sent: 0, failed: 0, removed: 0 };
  const wp = await getWebPush();
  if (!wp) return { skipped: "webpush_unavailable", sent: 0, failed: 0, removed: 0 };
  const subs = await listSubscriptions(teamId);
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0, total: 0, filtered: 0 };

  let sent = 0, failed = 0, filtered = 0;
  const dead = new Set();
  await Promise.all(
    subs.map(async (s) => {
      if (kind) {
        const prefs = s.prefs && typeof s.prefs === "object" ? s.prefs : defaultPrefs();
        if (prefs[kind] === false) {
          filtered++;
          return;
        }
      }
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
  return { sent, failed, removed, filtered, total: subs.length };
}
