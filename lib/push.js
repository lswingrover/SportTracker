// Server-side Web Push fan-out. web-push handles VAPID JWT signing and the
// FCM/APNs/Mozilla endpoint protocol. Subscriptions live in Blob storage
// keyed by team. Each subscription carries per-type prefs so users can
// silence categories they don't care about.

import { readJson, writeJson, blobConfigured } from "./blobStore.js";

// Canonical alert-type metadata. Timing-aware kinds (game-soon, work-soon)
// store an object pref { enabled, leadMinutes }. Plain kinds store a
// boolean. The UI iterates this list to render toggles + selectors.
export const ALERT_TYPES = [
  { id: "game-soon", label: "Game starting", timing: true, defaultLead: 30 },
  { id: "live-score", label: "Live score updates" },
  { id: "final-result", label: "Final results" },
  { id: "schedule-change", label: "Schedule / court changes" },
  { id: "bracket-advance", label: "Bracket advancement" },
  { id: "work-soon", label: "Work duty", timing: true, defaultLead: 30 },
];
export const LEAD_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90];

const TYPE_BY_ID = Object.fromEntries(ALERT_TYPES.map((t) => [t.id, t]));

export function defaultPrefs() {
  const out = {};
  for (const t of ALERT_TYPES) {
    out[t.id] = t.timing ? { enabled: true, leadMinutes: t.defaultLead } : true;
  }
  return out;
}

// Read a single pref value as a normalized { enabled, leadMinutes } object,
// regardless of whether it was stored as a bool or as { enabled, lead }.
// Lead is null for non-timing kinds.
export function prefValue(prefs, id) {
  const meta = TYPE_BY_ID[id];
  const raw = prefs?.[id];
  if (meta?.timing) {
    if (typeof raw === "object" && raw !== null) {
      const lead = LEAD_OPTIONS.includes(raw.leadMinutes)
        ? raw.leadMinutes
        : meta.defaultLead;
      return { enabled: raw.enabled !== false, leadMinutes: lead };
    }
    if (typeof raw === "boolean") {
      return { enabled: raw, leadMinutes: meta.defaultLead };
    }
    // Default if missing entirely.
    return { enabled: true, leadMinutes: meta.defaultLead };
  }
  if (typeof raw === "boolean") return { enabled: raw, leadMinutes: null };
  return { enabled: true, leadMinutes: null };
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
      const raw = input[t.id];
      if (raw == null) continue;
      if (t.timing) {
        if (typeof raw === "boolean") {
          out[t.id] = { enabled: raw, leadMinutes: t.defaultLead };
        } else if (typeof raw === "object") {
          const lead = LEAD_OPTIONS.includes(raw.leadMinutes)
            ? raw.leadMinutes
            : t.defaultLead;
          out[t.id] = { enabled: raw.enabled !== false, leadMinutes: lead };
        }
      } else if (typeof raw === "boolean") {
        out[t.id] = raw;
      }
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

// Send to an explicit subscriber list. Used by stateDiff after it's
// already filtered subscribers by per-type prefs (e.g., game-soon
// subscribers in the 20-min lead bucket). Endpoints that return 404/410
// are pruned from the team's blob.
export async function pushToSubscribers(teamId, subs, payload) {
  if (!pushConfigured()) return { skipped: "not_configured", sent: 0, failed: 0, removed: 0 };
  if (!Array.isArray(subs) || subs.length === 0) return { sent: 0, failed: 0, removed: 0, total: 0 };
  const wp = await getWebPush();
  if (!wp) return { skipped: "webpush_unavailable", sent: 0, failed: 0, removed: 0 };

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
    const all = await listSubscriptions(teamId);
    const fresh = all.filter((s) => !dead.has(s.endpoint));
    await writeJson(subsKey(teamId), { subs: fresh });
    removed = dead.size;
  }
  return { sent, failed, removed, total: subs.length };
}

// Fire a push notification to every subscriber whose prefs[kind].enabled
// is true. For non-timing kinds (final-result, schedule-change, live-score,
// bracket-advance). Use pushToSubscribers for timing-aware kinds where the
// state diff already bucketed subscribers by leadMinutes.
export async function pushToTeam(teamId, payload, kind = null) {
  const subs = await listSubscriptions(teamId);
  let eligible = subs;
  if (kind) {
    eligible = subs.filter((s) => prefValue(s.prefs, kind).enabled);
  }
  return pushToSubscribers(teamId, eligible, payload);
}
