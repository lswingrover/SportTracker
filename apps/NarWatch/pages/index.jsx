import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Head from "next/head";
import { TOURNAMENTS } from "../lib/tournamentData.js";

// ─── Lazy-loaded component cluster (GH#11) ────────────────────────────────────
// LeaderboardTab, PlayerSheet, and H2HSheet are only needed on user interaction
// (tab tap / row tap). next/dynamic defers their JS chunk from the initial load.
const LeaderboardTab = dynamic(
  () => import("../components/LeaderboardCluster").then((m) => m.LeaderboardTab),
  { ssr: false, loading: () => null }
);
const PlayerSheet = dynamic(
  () => import("../components/LeaderboardCluster").then((m) => m.PlayerSheet),
  { ssr: false, loading: () => null }
);
const H2HSheet = dynamic(
  () => import("../components/LeaderboardCluster").then((m) => m.H2HSheet),
  { ssr: false, loading: () => null }
);

const THEMES = [
  { id: "default", label: "Sport (orange)" },
  { id: "narwhal", label: "Narwhal (teal)" },
];

// Default fallback — used before first data load and for non-NIWP sources.
// Once the NIWP API responds, _pollSchedule overrides this dynamically.
const DEFAULT_REFRESH_MS = 2 * 60 * 1000;

// ─── Client-side data cache ───────────────────────────────────────────────────
// Module-level Map: persists across re-renders, hydrated from localStorage on
// first access so revisits render instantly from disk.
// Key: fetch URL (without &force=1 suffix). Value: { payload, fetchedAt }.
//
// Strategy: stale-while-revalidate.
//   • Fresh  (age < TTL) → serve from cache, skip fetch entirely.
//   • Stale  (age ≥ TTL) → serve stale immediately (no spinner), then
//                           re-fetch in the background and update silently.
//   • Miss                → show spinner, fetch, populate cache.
//   • force=true          → bypass cache, re-fetch, overwrite cache entry.
const CLIENT_DATA_CACHE = new Map(); // url → { payload, fetchedAt }
const CLIENT_CACHE_TTL_MS = 60 * 1000; // 1 minute — matches server-side TTL

// localStorage persistence: stale entries up to 24h are served instantly on
// revisit (then refreshed in background via SWR). Older than that, we discard.
const LS_CACHE_PREFIX = "narwatch:cache:v1:";
const LS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let _cacheHydrated = false;

function hydrateCacheFromLocalStorage() {
  if (_cacheHydrated || typeof window === "undefined") return;
  _cacheHydrated = true;
  try {
    const now = Date.now();
    const toDelete = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(LS_CACHE_PREFIX)) continue;
      try {
        const entry = JSON.parse(window.localStorage.getItem(key));
        if (!entry || !entry.payload || !entry.fetchedAt) { toDelete.push(key); continue; }
        if (now - entry.fetchedAt > LS_CACHE_MAX_AGE_MS) { toDelete.push(key); continue; }
        const url = key.slice(LS_CACHE_PREFIX.length);
        CLIENT_DATA_CACHE.set(url, entry);
      } catch { toDelete.push(key); }
    }
    for (const k of toDelete) window.localStorage.removeItem(k);
  } catch {} // localStorage blocked (Safari private mode etc) — fall back to memory only
}

function persistCacheEntry(url, entry) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_CACHE_PREFIX + url, JSON.stringify(entry));
  } catch {
    // Quota exceeded — drop the oldest half and retry once.
    pruneOldestLocalStorageEntries();
    try { window.localStorage.setItem(LS_CACHE_PREFIX + url, JSON.stringify(entry)); } catch {}
  }
}

function pruneOldestLocalStorageEntries() {
  if (typeof window === "undefined") return;
  const all = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(LS_CACHE_PREFIX)) continue;
    try {
      const entry = JSON.parse(window.localStorage.getItem(key));
      all.push({ key, fetchedAt: entry?.fetchedAt || 0 });
    } catch { window.localStorage.removeItem(key); }
  }
  all.sort((a, b) => a.fetchedAt - b.fetchedAt);
  const toRemove = Math.max(1, Math.floor(all.length / 2));
  for (let i = 0; i < toRemove; i++) window.localStorage.removeItem(all[i].key);
}

function writeCache(url, payload) {
  const entry = { payload, fetchedAt: Date.now() };
  CLIENT_DATA_CACHE.set(url, entry);
  persistCacheEntry(url, entry);
}

// Hydrate at module load so every consumer (load(), prefetch effect) sees
// the disk cache without each one having to remember to hydrate first.
// No-op on the server (guarded inside hydrateCacheFromLocalStorage).
hydrateCacheFromLocalStorage();

// ─── niwp-weeks localStorage cache ───────────────────────────────────────────
// Persists the /api/niwp-weeks response so returning users get instant weekKey
// resolution on mount — eliminating the fetch waterfall that previously blocked
// every tournament data load. Refs GH#10, GH#13.
//
// Max age: 7 days. niwpWeeks changes only when NIWP adds/removes tournament
// weeks, which happens at most once per week. Stale data is fine here — the
// background fetch always runs to refresh, SWR semantics.
const LS_NIWP_WEEKS_KEY = "narwatch:niwpweeks:v1";
const LS_NIWP_WEEKS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readCachedNiwpWeeks() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_NIWP_WEEKS_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.weeks) || !entry.fetchedAt) return null;
    if (Date.now() - entry.fetchedAt > LS_NIWP_WEEKS_MAX_AGE_MS) {
      window.localStorage.removeItem(LS_NIWP_WEEKS_KEY);
      return null;
    }
    return entry.weeks;
  } catch { return null; }
}

function persistNiwpWeeks(weeks) {
  if (typeof window === "undefined" || !Array.isArray(weeks)) return;
  try {
    window.localStorage.setItem(LS_NIWP_WEEKS_KEY, JSON.stringify({ weeks, fetchedAt: Date.now() }));
  } catch {} // quota — non-critical, weeks list is tiny
}

function slugifyHashValue(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readHashParams() {
  if (typeof window === "undefined") return {};
  const raw = window.location.hash.replace(/^#/, "");
  const out = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const v = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
    if (k) out[k] = v;
  }
  return out;
}

/** Build a /api/tournament query URL, omitting eventId/divId when undefined.
 *  Prevents literal "eventId=undefined" from appearing in fetch URLs and
 *  calendar links when a static tournament (dataSource:"niwp") is active (GH#4). */
function buildTournamentUrl({ eventId, divId, teamId, teamName, weekKey } = {}) {
  let q = "/api/tournament?";
  if (eventId != null) q += `eventId=${encodeURIComponent(String(eventId))}&`;
  if (divId   != null) q += `divId=${encodeURIComponent(String(divId))}&`;
  q += `teamId=${encodeURIComponent(String(teamId))}&teamName=${encodeURIComponent(String(teamName))}`;
  if (weekKey != null) q += `&weekKey=${encodeURIComponent(String(weekKey))}`;
  return q;
}

/** Return true if the ISO weekKey ("YYYY-WNN") ends no more than weeksBack
 *  weeks in the past (or is still upcoming).  Prevents stale static chips
 *  from re-surfacing once NIWP data ages past the week they were
 *  introduced — e.g. the Bend chip reappearing months after the tournament
 *  if NIWP no longer covers W16 (GH#7). */
function isWeekKeyRecent(weekKey, weeksBack = 4) {
  if (!weekKey) return true;
  const m = weekKey.match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return true;
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  // ISO week-1 always contains Jan 4.  Derive Monday of that week, then
  // advance by (week - 1) * 7 days to reach the target week's Monday.
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  // Sunday of that ISO week = monday + 6 days.
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return Date.now() <= sunday.getTime() + weeksBack * 7 * 24 * 60 * 60 * 1000;
}

// NIWP schedule team filter options (mirrors LB_TEAM_FILTERS in the Leaderboard).
const NIWP_TEAM_FILTERS = [
  { key: "all",  label: "All teams" },
  { key: "B",    label: "18U Boys" },
  { key: "G",    label: "18U Girls" },
  { key: "BJV",  label: "JV Boys" },
  { key: "GJV",  label: "JV Girls" },
  { key: "D",    label: "Dev" },
];

// Subteam key → badge label
const SUBTEAM_LABELS = { B: "18U Boys", G: "18U Girls", BJV: "JV Boys", GJV: "JV Girls", D: "Dev" };
const CONFETTI_SRC = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";

function pad(n) {
  return String(n).padStart(2, "0");
}

// Tournament tz handling. Tournament config carries an IANA timezone
// (e.g. America/Denver for Big Sky in Billings, America/Los_Angeles for
// ERVA in Spokane). Render every time in the venue's wall-clock so a
// parent in California still sees the Spokane match at the right moment.
const TZ_SHORT_LABEL = {
  "America/Los_Angeles": "PT",
  "America/Denver": "MT",
  "America/Phoenix": "MST",
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "America/Anchorage": "AKT",
  "Pacific/Honolulu": "HT",
};

function tzShortLabel(tz) {
  return TZ_SHORT_LABEL[tz] || null;
}

function formatInTz(iso, tz, opts) {
  if (!iso) return null;
  try {
    const base = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    };
    const merged = opts ? { ...base, ...opts } : base;
    if (tz) merged.timeZone = tz;
    return new Date(iso).toLocaleString("en-US", merged);
  } catch {
    return iso;
  }
}

function formatTimeOfDayInTz(iso, tz) {
  if (!iso) return null;
  try {
    const opts = { hour: "numeric", minute: "2-digit" };
    if (tz) opts.timeZone = tz;
    return new Date(iso).toLocaleTimeString("en-US", opts);
  } catch {
    return iso;
  }
}

function icsDate(iso) {
  const d = new Date(iso);
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    "00Z"
  );
}

function buildSingleICS(g, teamName) {
  const start = g.timeISO;
  if (!start) return null;
  const end = new Date(new Date(start).getTime() + 75 * 60 * 1000).toISOString();
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NarWatch//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${g.id}@narwhaltracker`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${teamName} vs ${g.opponent}`,
    `LOCATION:Court ${g.court}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadICS(filename, content) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function useInterval(callback, ms) {
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  });
  useEffect(() => {
    const id = setInterval(() => cb.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function useCountdown(targetISO) {
  // Initial state is null on both server and client first render to avoid
  // hydration mismatches when an upcoming event is present. Time ticks in
  // after mount via useEffect.
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  if (!targetISO || now == null) return null;
  return Math.round((new Date(targetISO).getTime() - now) / 60000);
}

function usePersistentState(key, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw));
    } catch {}
    // intentionally only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}

function detectChangedIds(prev, next) {
  const out = new Set();
  if (!prev || !Array.isArray(prev.games)) return out;
  const map = new Map(prev.games.map((g) => [g.id, g]));
  for (const g of next.games || []) {
    const old = map.get(g.id);
    if (!old) continue;
    if (old.court !== g.court || old.timeISO !== g.timeISO) out.add(g.id);
  }
  return out;
}

function detectNewWins(prev, next) {
  const wins = [];
  if (!prev || !Array.isArray(prev.games)) return wins;
  const map = new Map(prev.games.map((g) => [g.id, g]));
  for (const g of next.games || []) {
    const old = map.get(g.id);
    if (g.result === "W" && (!old || old.result !== "W")) wins.push(g);
  }
  return wins;
}

let confettiPromise = null;
function loadConfetti() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.confetti) return Promise.resolve(window.confetti);
  if (confettiPromise) return confettiPromise;
  confettiPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = CONFETTI_SRC;
    s.async = true;
    s.onload = () => resolve(window.confetti || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return confettiPromise;
}

async function celebrate(themeId) {
  const c = await loadConfetti();
  if (!c) return;
  // Narwhals water polo — royal blue + hot pink + white. Default theme keeps
  // the orange/green/white burst.
  const colors =
    themeId === "narwhal"
      ? ["#1E3EBF", "#FF69B4", "#ffffff"]
      : ["#f97316", "#ffffff", "#22c55e"];
  c({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors });
  setTimeout(() => c({ particleCount: 60, angle: 60, spread: 55, origin: { x: 0 }, colors }), 200);
  setTimeout(() => c({ particleCount: 60, angle: 120, spread: 55, origin: { x: 1 }, colors }), 250);
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }
}

function LiveScoreBanner({ live, lastChangedAt, watchUrl }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!live) return null;
  const idleMs = lastChangedAt ? Date.now() - lastChangedAt : 0;
  const stale = idleMs > 5 * 60 * 1000;
  const ago = lastChangedAt
    ? Math.max(0, Math.round(idleMs / 1000))
    : null;
  const sets = live.rawSets || [];
  return (
    <section className="live-banner" aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="live-tag">
          <span className="live-dot" /> Live
        </span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          Court {live.court}
          {ago != null && ` · updated ${ago}s ago`}
        </span>
      </div>
      <div className="matchup">NIN vs {live.opponent}</div>
      <div className="scoreline">
        <span style={{ color: "var(--text)" }}>{live.us}</span>
        <span className="vs">–</span>
        <span style={{ color: live.them > live.us ? "var(--loss)" : "var(--text)" }}>
          {live.them}
        </span>
        <span className="vs" style={{ fontSize: 18 }}>
          Q{live.setNumber}
        </span>
      </div>
      {sets.length > 0 && (
        <div className="stacked-sets">
          {sets.slice(0, 4).map((s, i) => {
            const inProgress = i === sets.length - 1 && !s.complete;
            const cls = ["set-row", inProgress ? "in-progress" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div className={cls} key={i}>
                <span className="label">
                  Q{i + 1}
                  {inProgress ? " · ● Live" : s.complete ? " ✓" : ""}
                </span>
                <span>
                  {s.us} – {s.them}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {stale && (
        <div className="meta" style={{ marginTop: 6, color: "var(--warn)" }}>
          ⏸ Score hasn't moved in {Math.round(idleMs / 60000)} min
        </div>
      )}
      {watchUrl && (
        <div style={{ marginTop: 10 }}>
          <a className="btn-mini primary" href={watchUrl} target="_blank" rel="noreferrer">
            📺 Watch this court live
          </a>
        </div>
      )}
    </section>
  );
}

function NextHero({ event, minutesUntil, projectedDone, eventOver, tz }) {
  const tzLabel = tzShortLabel(tz);
  if (!event) {
    if (eventOver) {
      return (
        <section className="hero empty">
          <h2>🏁 Tournament complete</h2>
          <div className="meta">All matches finished. See past games and final standings below.</div>
        </section>
      );
    }
    return (
      <section className="hero empty">
        <h2>No upcoming match</h2>
        <div className="meta">
          {projectedDone
            ? `Projected end: ${formatInTz(projectedDone, tz)}${tzLabel ? ` ${tzLabel}` : ""}`
            : "Schedule data not yet available."}
        </div>
      </section>
    );
  }
  const work = event.kind === "work";
  const eventLocalized = event.timeISO
    ? `${formatInTz(event.timeISO, tz)}${tzLabel ? ` ${tzLabel}` : ""}`
    : event.time;
  return (
    <section className={`hero${work ? " work" : ""}`}>
      <h2>
        {work ? "🟡 Next work duty" : "▶ Next match"}
      </h2>
      <div className="opp">
        {work ? event.role : `vs ${event.opponent}`}
      </div>
      <div className="meta">
        {eventLocalized} · Court {event.court}
        {work && event.teams ? ` · ${event.teams}` : ""}
      </div>
      <div className="countdown">
        <span className="num">
          {minutesUntil != null
            ? minutesUntil > 60
              ? `${Math.floor(minutesUntil / 60)}h ${minutesUntil % 60}m`
              : `${minutesUntil}`
            : "—"}
        </span>
        <span className="unit">
          {minutesUntil != null && minutesUntil <= 60 ? "min until tip" : "until tip"}
        </span>
      </div>
      {event.isRunningLate && (
        <div className="meta" style={{ marginTop: 8, color: "var(--muted)" }}>
          May start later than scheduled
        </div>
      )}
    </section>
  );
}

// Per-type alert toggles. Keep in sync with ALERT_TYPES in lib/push.js.
// Timing-aware kinds (game-soon, work-soon) store { enabled, leadMinutes };
// others store boolean.
const CLIENT_ALERT_TYPES = [
  { id: "game-soon", label: "Game starting", timing: true, defaultLead: 30 },
  { id: "live-score", label: "Live score updates" },
  { id: "final-result", label: "Final results (Won / Lost)" },
  { id: "schedule-change", label: "Schedule / pool changes" },
  { id: "bracket-advance", label: "Bracket advancement" },
];
const LEAD_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90];

function defaultClientPrefs() {
  const out = {};
  for (const t of CLIENT_ALERT_TYPES) {
    out[t.id] = t.timing ? { enabled: true, leadMinutes: t.defaultLead } : true;
  }
  return out;
}

function readClientPref(prefs, t) {
  const raw = prefs?.[t.id];
  if (t.timing) {
    if (typeof raw === "object" && raw !== null) {
      return {
        enabled: raw.enabled !== false,
        leadMinutes: LEAD_OPTIONS.includes(raw.leadMinutes) ? raw.leadMinutes : t.defaultLead,
      };
    }
    if (typeof raw === "boolean") return { enabled: raw, leadMinutes: t.defaultLead };
    return { enabled: true, leadMinutes: t.defaultLead };
  }
  if (typeof raw === "boolean") return { enabled: raw };
  return { enabled: true };
}

// Convert URL-safe base64 (VAPID public key format) to Uint8Array required
// by PushManager.subscribe.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function NotificationsCard({ teamId, onShowA2HS }) {
  // Stable initial state across SSR and client first render — Safari iOS
  // has no Notification or PushManager global; reading it during render
  // crashes hydration in production minified React.
  const [perm, setPerm] = useState("default");
  const [mounted, setMounted] = useState(false);
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [working, setWorking] = useState(false);
  const [prefs, setPrefs] = usePersistentState(`notifPrefs-${teamId}`, defaultClientPrefs());
  const endpointRef = useRef(null);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") return;
    const ok =
      typeof window.Notification !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setSupported(ok);
    if (!ok) return;
    setPerm(window.Notification.permission);
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpointRef.current = sub.endpoint;
        setSubscribed(true);
      }
    });
  }, []);

  async function subscribe() {
    if (typeof window === "undefined" || !supported) return;
    setWorking(true);
    try {
      const result = await window.Notification.requestPermission();
      setPerm(result);
      if (result !== "granted") return;
      const reg =
        (await navigator.serviceWorker.getRegistration()) ||
        (await navigator.serviceWorker.register("/sw.js"));
      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapid) {
        alert("Push not configured (no VAPID public key)");
        return;
      }
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      const res = await fetch("/api/push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, teamId, prefs }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        console.warn("subscribe failed:", err);
        return;
      }
      endpointRef.current = subscription.endpoint;
      setSubscribed(true);
    } catch (err) {
      console.warn("Web Push subscribe error:", err);
    } finally {
      setWorking(false);
    }
  }

  async function unsubscribe() {
    if (!supported) return;
    setWorking(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push-unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint, teamId }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      endpointRef.current = null;
      setSubscribed(false);
    } finally {
      setWorking(false);
    }
  }

  function syncPrefs(next) {
    setPrefs(next);
    if (subscribed && endpointRef.current) {
      fetch("/api/push-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, endpoint: endpointRef.current, prefs: next }),
      }).catch(() => {});
    }
  }

  function togglePref(t) {
    const cur = readClientPref(prefs, t);
    const nextVal = t.timing
      ? { enabled: !cur.enabled, leadMinutes: cur.leadMinutes }
      : !cur.enabled;
    syncPrefs({ ...prefs, [t.id]: nextVal });
  }

  function setLeadMinutes(t, lead) {
    const cur = readClientPref(prefs, t);
    syncPrefs({
      ...prefs,
      [t.id]: { enabled: cur.enabled, leadMinutes: lead },
    });
  }

  if (!mounted) return null;
  if (!supported) {
    return (
      <button
        type="button"
        className="notif-card press-feedback notif-card-action"
        onClick={onShowA2HS}
        aria-label="Enable notifications by adding to home screen"
      >
        <div style={{ minWidth: 0, textAlign: "left" }}>
          <div className="title">
            <span>🔔</span>
            <span>Enable notifications — add to Home Screen →</span>
          </div>
          <div className="desc">
            iOS Safari only delivers push alerts in standalone mode. Tap to see
            the steps.
          </div>
        </div>
      </button>
    );
  }

  const blocked = perm === "denied";
  const on = subscribed && perm === "granted";

  return (
    <div className={`notif-card${on ? " on" : ""}`}>
      <div className="notif-head">
        <div style={{ minWidth: 0 }}>
          <div className="title">
            <span>🔔</span>
            <span>Notifications</span>
            <span className={`state${on ? " on" : blocked ? " blocked" : ""}`}>
              {on ? "On" : blocked ? "Blocked" : "Off"}
            </span>
          </div>
          <div className="desc">
            {blocked
              ? "Notifications are blocked in browser settings — enable them there to receive alerts."
              : on
                ? "Pushed live, even when this tab is closed."
                : "Pushed live, even when this tab is closed. Pick what you want to hear about, then enable."}
          </div>
        </div>
        {!blocked &&
          (on ? (
            <button className="btn-secondary" onClick={unsubscribe} disabled={working}>
              {working ? "…" : "Off"}
            </button>
          ) : (
            <button className="btn-primary" onClick={subscribe} disabled={working}>
              {working ? "…" : "Enable"}
            </button>
          ))}
      </div>
      {!blocked && (
        <ul className="notif-prefs">
          {CLIENT_ALERT_TYPES.map((t) => {
            const cur = readClientPref(prefs, t);
            return (
              <li key={t.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={cur.enabled}
                    onChange={() => togglePref(t)}
                  />
                  <span>{t.label}</span>
                </label>
                {t.timing && cur.enabled && (
                  <select
                    className="lead-select"
                    value={cur.leadMinutes}
                    onChange={(e) => setLeadMinutes(t, Number(e.target.value))}
                    aria-label={`${t.label} lead time`}
                  >
                    {LEAD_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} min before
                      </option>
                    ))}
                  </select>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CalendarCard({ origin, eventId, divId, teamId, teamName, gameCount }) {
  // Guard: static tournaments lack eventId/divId — omit those params entirely
  // rather than writing literal "eventId=undefined" into the calendar URL (GH#4).
  let _calUrl = `${origin}/api/calendar.ics?`;
  if (eventId != null) _calUrl += `eventId=${encodeURIComponent(String(eventId))}&`;
  if (divId   != null) _calUrl += `divId=${encodeURIComponent(String(divId))}&`;
  _calUrl += `teamId=${teamId}&teamName=${encodeURIComponent(teamName)}`;
  const url = _calUrl;
  const webcal = url.replace(/^https?:/, "webcal:");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      alert("Calendar URL copied. Paste it into your calendar app's 'Subscribe' option.");
    } catch {
      window.prompt("Copy this URL:", url);
    }
  }

  return (
    <div className="calendar-section">
      <div className="row">
        <div className="lhs">
          <div className="icon">📅</div>
          <div>
            <div className="label">Subscribe to calendar</div>
            <div className="sub">
              {gameCount > 0 ? `${gameCount} game${gameCount === 1 ? "" : "s"} · ` : ""}
              Auto-updates if schedule changes
            </div>
          </div>
        </div>
        <a className="btn-mini primary" href={webcal}>
          Subscribe to Calendar
        </a>
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn-mini" onClick={copy}>
          Copy link
        </button>
      </div>
    </div>
  );
}

// Group static games by calendar day in the venue timezone.
// Returns [{ dayLabel: "Friday, May 15", games: [...] }, ...]
function groupGamesByDay(games, tz) {
  const map = new Map();
  for (const g of games) {
    const dayLabel = g.timeISO
      ? new Date(g.timeISO).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: tz || "America/Los_Angeles",
        })
      : "TBD";
    if (!map.has(dayLabel)) map.set(dayLabel, []);
    map.get(dayLabel).push(g);
  }
  return Array.from(map.entries()).map(([dayLabel, dayGames]) => ({ dayLabel, dayGames }));
}

function StaticTournamentCard({ tournament }) {
  const { venue, date, label, games: staticGames } = tournament;
  const tz = venue?.tz || "America/Los_Angeles";
  const tzLabel = tzShortLabel(tz);
  const mapsHref =
    venue?.address &&
    `https://maps.apple.com/?q=${encodeURIComponent(`${venue.name || ""} ${venue.address}`.trim())}`;

  const hasGames = Array.isArray(staticGames) && staticGames.length > 0;
  const grouped = hasGames ? groupGamesByDay(staticGames, tz) : [];
  const allDone = hasGames && staticGames.every((g) => g.done);
  const wins = hasGames ? staticGames.filter((g) => g.done && g.result === "W").length : 0;
  const losses = hasGames ? staticGames.filter((g) => g.done && g.result === "L").length : 0;

  return (
    <section className="static-card">
      <div className="static-eyebrow">📅 Tournament</div>
      <div className="static-name">{label}</div>
      <div className="static-meta">{date}</div>
      {venue?.name && <div className="static-venue">{venue.name}</div>}
      {venue?.address && (
        <div className="static-meta">
          {mapsHref ? (
            <a href={mapsHref} target="_blank" rel="noreferrer">
              📍 {venue.address}
            </a>
          ) : (
            <>📍 {venue.address}</>
          )}
        </div>
      )}
      <div className="static-divider" />

      {hasGames ? (
        <>
          {(wins > 0 || losses > 0) && (
            <div className="static-record">
              {wins > 0 && <span className="static-record-w">{wins}W</span>}
              {losses > 0 && <span className="static-record-l">{losses}L</span>}
            </div>
          )}
          <div className="static-schedule">
            {grouped.map(({ dayLabel, dayGames }) => (
              <div key={dayLabel} className="static-day">
                <div className="static-day-label">{dayLabel}</div>
                {dayGames.map((g) => {
                  const timeStr = g.timeISO
                    ? formatTimeOfDayInTz(g.timeISO, tz)
                    : g.time || "TBD";
                  const resultGlyph =
                    g.done && g.result === "W" ? "✅" :
                    g.done && g.result === "L" ? "❌" : null;
                  return (
                    <div key={g.id} className={`static-game${g.done ? " done" : ""}${g.isBracket ? " bracket" : ""}`}>
                      <div className="static-game-time">
                        {timeStr}{tzLabel ? <span className="static-tz">{tzLabel}</span> : null}
                      </div>
                      <div className="static-game-main">
                        {resultGlyph && <span className="static-result-glyph">{resultGlyph}</span>}
                        <span className="static-game-opp">
                          {g.isBracket ? "Bracket" : `vs ${g.opponent}`}
                        </span>
                        {g.done && g.score && (
                          <span className="static-game-score">{g.score}</span>
                        )}
                      </div>
                      {g.isBracket && g.bracketCondition && (
                        <div className="static-game-note">{g.bracketCondition}</div>
                      )}
                      {!g.isBracket && g.gameLabel && (
                        <div className="static-game-note">
                          {g.gameLabel}{g.court && g.court !== "TBD" ? ` · ${g.court}` : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="static-note" style={{ marginTop: 14 }}>
            {allDone
              ? "Tournament complete. Live scoring picks up automatically when NIWP covers this event."
              : "Schedule locked. Scores updated manually until NIWP or WPC picks up the tournament."}
          </div>
        </>
      ) : (
        <div className="static-note">
          No data available for this tournament yet. Check back closer to game time.
        </div>
      )}
    </section>
  );
}

function SeasonArc({ pastGames, onDotTap }) {
  if (!pastGames || pastGames.length === 0) return null;
  return (
    <div className="season-arc" aria-label="Season results">
      <span className="arc-label">Arc</span>
      {pastGames.map((g) => (
        <button
          type="button"
          key={g.id}
          className={`arc-dot press-feedback ${g.result === "W" ? "w" : g.result === "L" ? "l" : ""}`}
          title={`${g.result || "?"} vs ${g.opponent}`}
          aria-label={`${g.result === "W" ? "Win" : "Loss"} vs ${g.opponent}`}
          onClick={() => onDotTap?.(g.id)}
        />
      ))}
    </div>
  );
}

function UpcomingTournamentCountdown({ tournament, eventMeta, onTap }) {
  // Server and client both render with daysAway=null first; useEffect fills in
  // after mount to avoid hydration drift.
  const [daysAway, setDaysAway] = useState(null);
  useEffect(() => {
    const startISO = eventMeta?.startDate || null;
    if (!startISO) return;
    const ms = new Date(startISO).getTime() - Date.now();
    setDaysAway(Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000))));
  }, [eventMeta?.startDate]);

  const venue = tournament?.venue;
  const mapHref = venue?.address
    ? mapsHrefFor(`${venue.name || ""} ${venue.address}`.trim())
    : null;

  return (
    <section className="upcoming-card">
      <button
        type="button"
        onClick={onTap}
        aria-label="Tournament details"
        className="press-feedback"
        style={{
          background: "transparent",
          border: 0,
          cursor: "pointer",
          color: "inherit",
          font: "inherit",
          padding: "8px 4px",
          width: "100%",
          display: "block",
        }}
      >
        <div className="eyebrow">Tournament starts in</div>
        <div className="countdown-num">{daysAway != null ? daysAway : "—"}</div>
        <div className="countdown-unit">{daysAway === 1 ? "day" : "days"}</div>
      </button>
      {venue?.name && <div className="upcoming-venue">{venue.name}</div>}
      {venue?.address && (
        <div className="upcoming-meta">
          {mapHref ? (
            <a href={mapHref} target="_blank" rel="noreferrer">
              📍 {venue.address}
            </a>
          ) : (
            <>📍 {venue.address}</>
          )}
        </div>
      )}
    </section>
  );
}

function PastGamesSummary({ standings, record }) {
  const us = standings.find((s) => s.isUs);
  const setsWon = us?.setsWon ?? null;
  const setsLost = us?.setsLost ?? null;
  return (
    <div className="record-summary">
      <span className="record-final">Final: {record.wins}–{record.losses}</span>
      {setsWon != null && setsLost != null && (
        <span className="record-sub">
          · {setsWon} set{setsWon === 1 ? "" : "s"} won, {setsLost} lost
        </span>
      )}
      {us?.rankText && <span className="record-sub"> · {us.rankText} in pool</span>}
    </div>
  );
}

function mapsHrefFor(query) {
  if (!query) return null;
  const q = encodeURIComponent(query);
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua);
    if (isApple) return `https://maps.apple.com/?q=${q}`;
  }
  return `https://maps.google.com/?q=${q}`;
}

function CourtHero({ court, venue, onTap }) {
  const courtLabel = court || "TBD";
  return (
    <button
      type="button"
      className="court-hero press-feedback"
      onClick={(e) => {
        e.stopPropagation();
        onTap?.(courtLabel, venue);
      }}
      aria-label={`Court ${courtLabel} info`}
    >
      <span className="court-pin">📍</span>Court {courtLabel}
    </button>
  );
}

// Render a 400×200 result graphic to a canvas, then share via the Web
// Share API (level-2 file sharing) or fall back to a PNG download. Used
// from past-game cards in the expanded state.
async function shareGameImage({ game, teamName, tz }) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const W = 400, H = 200;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1E3EBF");
  grad.addColorStop(1, "#0a1a4a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Result band — green for win, red for loss
  ctx.fillStyle = game.result === "W" ? "#22c55e" : "#ef4444";
  ctx.fillRect(0, 0, 6, H);

  // Team name
  ctx.fillStyle = "#FFFFFF";
  ctx.font = '700 18px "Barlow Condensed", system-ui, sans-serif';
  ctx.textBaseline = "top";
  ctx.fillText(teamName || "North Idaho Narwhals", 20, 18);

  // vs Opponent
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`vs ${game.opponent || "TBD"}`, 20, 42);

  // Big score (set count) center-left
  const setCount = setsCountForRow(game.sets);
  const big = setCount || (game.result === "W" ? "WON" : game.result === "L" ? "LOST" : "");
  ctx.fillStyle = "#FFFFFF";
  ctx.font = '900 72px "Barlow Condensed", system-ui, sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText(big, 20, H / 2 + 18);

  // Per-set scores (small, top-right column)
  if (Array.isArray(game.sets) && game.sets.length > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = '700 14px "Barlow Condensed", system-ui, sans-serif';
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    let y = 18;
    for (let i = 0; i < game.sets.length; i++) {
      const s = game.sets[i];
      ctx.fillText(`Set ${i + 1}: ${s.us}–${s.them}`, W - 18, y);
      y += 18;
    }
    ctx.textAlign = "left";
  }

  // Date (bottom-left, subtle)
  if (game.timeISO) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.textBaseline = "bottom";
    const date = formatInTz(game.timeISO, tz, { weekday: undefined, month: "short", day: "numeric", year: "numeric", hour: undefined, minute: undefined });
    ctx.fillText(date, 20, H - 16);
  }

  // Watermark (bottom-right)
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("narwatch.vercel.app", W - 18, H - 16);
  ctx.textAlign = "left";

  // Convert to blob → File and share / download
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const filename = `narwhal-${(game.opponent || "result").replace(/\s+/g, "_")}.png`;
  const file = new File([blob], filename, { type: "image/png" });

  const canFileShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canFileShare) {
    try {
      await navigator.share({
        files: [file],
        title: `${teamName} ${game.result === "W" ? "win" : "result"}`,
      });
      return;
    } catch {
      /* user cancelled; fall through to download */
    }
  }

  // Fallback: trigger a PNG download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setsCountForRow(sets) {
  if (!Array.isArray(sets) || !sets.length) return null;
  let us = 0, them = 0;
  for (const s of sets) {
    if (s.us > s.them) us++;
    else if (s.them > s.us) them++;
  }
  return `${us}–${them}`;
}

function UpcomingGameCard({ game, expanded, onToggle, venue, tz, teamWatchNowLink, opponentInfo, onAddCal, onOpenOpponent, onCourtTap }) {
  const watchUrl = game.videoLink || (game.live ? teamWatchNowLink : null);
  const tzLabel = tzShortLabel(tz);
  const localized = game.timeISO
    ? `${formatInTz(game.timeISO, tz)}${tzLabel ? ` ${tzLabel}` : ""}`
    : game.time || "TBD";
  const isLate =
    game.next &&
    !game.done &&
    !game.live &&
    game.timeISO &&
    new Date(game.timeISO).getTime() < Date.now() &&
    !game.score &&
    !(Array.isArray(game.sets) && game.sets.length > 0);
  const cls = [
    "card upcoming",
    expanded ? "expanded" : "",
    game.next && !game.live ? "next-pulse" : "",
    game.live ? "live-card" : "",
  ].filter(Boolean).join(" ");
  return (
    <article className={cls}>
      <div
        className="card-summary"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
      >
        <div style={{ minWidth: 0 }}>
          <CourtHero court={game.court} venue={venue} onTap={onCourtTap} />
          <div className="matchup">
            vs{" "}
            <span
              className="opp-tap h2h-link"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onOpenOpponent?.(game.opponent);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenOpponent?.(game.opponent);
                }
              }}
            >
              {game.opponent}
            </span>
            {game.subteam && SUBTEAM_LABELS[game.subteam] && (
              <span className="subteam-badge">{SUBTEAM_LABELS[game.subteam]}</span>
            )}
          </div>
          <div className="matchup-meta">{localized}</div>
          {isLate && <div className="late-badge">⏱ Running late</div>}
        </div>
        <div className="card-chevron">▸</div>
      </div>
      {expanded && (
        <div className="card-expanded">
          {opponentInfo && (
            <div className="meta">
              Opponent: {opponentInfo.matchesWon}–{opponentInfo.matchesLost}
              {opponentInfo.rank ? ` · #${opponentInfo.rank} in pool` : ""}
            </div>
          )}
          {game.courtStay && (
            <div className="meta" style={{ color: "var(--warn)" }}>
              {game.courtStay.stay
                ? `↪ Stay on Court ${game.court} for the next match`
                : game.courtStay.stayIfWin && game.courtStay.stayIfLoss
                  ? `↪ Stay on Court ${game.court} either way`
                  : game.courtStay.stayIfWin
                    ? `↪ Stay on Court ${game.court} if you win`
                    : game.courtStay.stayIfLoss
                      ? `↪ Stay on Court ${game.court} if you lose`
                      : null}
            </div>
          )}
          <div className="card-actions">
            {game.timeISO && (
              <button className="btn-mini" onClick={() => onAddCal(game)}>
                📅 Add to calendar
              </button>
            )}
            {watchUrl && (
              <a className="btn-mini primary" href={watchUrl} target="_blank" rel="noreferrer">
                📺 Watch live
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── StatsPanel ───────────────────────────────────────────────────────────────
// Lazily fetches and renders per-player stats for a NIWP game.
// Only rendered when expanded and game._source === "niwp".

function StatsPanel({ gameId }) {
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [stats, setStats]   = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    if (!gameId) return;
    setStatus("loading");
    fetch(`/api/stats?game_id=${encodeURIComponent(gameId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setStats(data.stats || []);
        setStatus("ready");
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus("error");
      });
  }, [gameId]);

  if (status === "idle" || status === "loading") {
    return <div className="stats-panel-loading">Loading player stats…</div>;
  }
  if (status === "error") {
    return <div className="stats-panel-error">Stats unavailable ({errorMsg})</div>;
  }
  if (!stats || stats.length === 0) {
    return <div className="meta">No player stats recorded for this game.</div>;
  }

  return (
    <div className="stats-panel">
      <div className="stats-panel-title">Player Stats</div>
      <table className="stats-panel-table">
        <thead>
          <tr>
            <th className="sp-name">Player</th>
            <th title="Goals">G</th>
            <th title="Assists">A</th>
            <th title="Steals">St</th>
            <th title="Blocks">Bl</th>
            <th title="Kickouts">KO</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={s.stat_id ?? i} className={i === 0 && s.goals > 0 ? "sp-top" : ""}>
              <td className="sp-name">
                {s.cap_number ? <span className="sp-cap">#{s.cap_number}</span> : null}
                {s.player_name}
              </td>
              <td className={s.goals > 0 ? "sp-hi" : ""}>{s.goals}</td>
              <td>{s.assists}</td>
              <td>{s.steals}</td>
              <td>{s.blocks}</td>
              <td>{s.kickouts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PastGameCard({ game, expanded, onToggle, venue, tz, opponentInfo, onShare, justWon, onOpenOpponent, teamName, onCourtTap, onResultBadgeTap }) {
  const tzLabel = tzShortLabel(tz);
  const localized = game.timeISO
    ? `${formatInTz(game.timeISO, tz)}${tzLabel ? ` ${tzLabel}` : ""}`
    : game.time || "";
  const setsCount = setsCountForRow(game.sets);
  const cls = [
    "card past",
    expanded ? "expanded" : "",
    game.result === "W" ? "win" : "",
    game.result === "L" ? "loss" : "",
    justWon ? "just-won" : "",
  ].filter(Boolean).join(" ");
  return (
    <article className={cls} id={`game-${game.id}`}>
      <div
        className="card-summary"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
      >
        <div className="past-summary-left">
          <div className="score-hero">{setsCount || game.score || (game.result === "W" ? "Won" : game.result === "L" ? "Lost" : "—")}</div>
          <div className="score-meta">
            vs{" "}
            <span
              className="opp-tap h2h-link"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onOpenOpponent?.(game.opponent);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenOpponent?.(game.opponent);
                }
              }}
            >
              {game.opponent}
            </span>
            {game.subteam && SUBTEAM_LABELS[game.subteam] && (
              <span className="subteam-badge">{SUBTEAM_LABELS[game.subteam]}</span>
            )}
          </div>
          <div className="score-meta">
            Court {game.court || "?"}
            {localized ? ` · ${localized}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          {game.result === "W" && (
            <button
              type="button"
              className="badge win press-feedback"
              onClick={(e) => {
                e.stopPropagation();
                onResultBadgeTap?.("wins");
              }}
              aria-label="Show all wins"
            >
              Won
            </button>
          )}
          {game.result === "L" && (
            <button
              type="button"
              className="badge loss press-feedback"
              onClick={(e) => {
                e.stopPropagation();
                onResultBadgeTap?.("losses");
              }}
              aria-label="Show all losses"
            >
              Lost
            </button>
          )}
          <div className="card-chevron">▸</div>
        </div>
      </div>
      {expanded && (
        <div className="card-expanded">
          {Array.isArray(game.sets) && game.sets.length > 0 ? (
            <table className="set-table">
              <thead>
                <tr>
                  <th>Quarter</th>
                  <th>NIN</th>
                  <th>Opp</th>
                </tr>
              </thead>
              <tbody>
                {game.sets.slice(0, 4).map((s, i) => {
                  const usWin = s.us > s.them;
                  return (
                    <tr key={i}>
                      <td>Q{i + 1}</td>
                      <td className={usWin ? "win-side" : ""}>{s.us}</td>
                      <td className={!usWin ? "loss-side" : ""}>{s.them}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : game.score ? (
            <div className="meta">Score: {game.score}</div>
          ) : null}
          {opponentInfo && (
            <div className="meta">
              Opp record: {opponentInfo.matchesWon}–{opponentInfo.matchesLost}
              {opponentInfo.rank ? ` · #${opponentInfo.rank} in pool` : ""}
            </div>
          )}
          {game._source === "niwp" && game._gameId && (
            <StatsPanel gameId={game._gameId} />
          )}
          <div className="card-actions">
            {game.result && (
              <button className="btn-mini" onClick={() => onShare(game)}>
                📣 Share text
              </button>
            )}
            {game.result && (
              <button
                className="btn-mini primary"
                onClick={() => shareGameImage({ game, teamName, tz })}
              >
                🖼 Share image
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// 12-step guided tour. Each step has an optional CSS selector to highlight
// (cutout overlay), an optional setupTab to switch into before the step
// renders, and optional sideEffect (confetti, etc.). When no selector
// matches, the bubble centers with a full dim backdrop.
const TOUR_STEPS = [
  { selector: ".chip-row", title: "Tournaments", body: "Tap any chip to switch tournaments. Past events show final records; future ones show countdowns." },
  { selector: ".stats", title: "Tournament record", body: "Tap Wins or Losses to see a game-by-game breakdown." },
  { selector: ".card.upcoming", setupTab: "schedule", title: "Upcoming game", body: "Court number is the hero — tap it for venue details. Tap the opponent name for head-to-head history." },
  { title: "Live score banner", body: "When a game is live, this banner appears with real-time scores updated every 30 seconds." },
  { sideEffect: "confetti", title: "🎉 Wins!", body: "Win a game and the app celebrates with confetti." },
  { selector: ".card.past", setupTab: "schedule", title: "Past games", body: "Tap any past game to expand. See set-by-set scores and share the result as an image." },
  { selector: ".tabs button:nth-child(2)", setupTab: "standings", title: "Standings", body: "Tap any team row to see their record and your head-to-head history. The Narwhals row pinned at the top opens a season summary." },
  { selector: ".tabs button:nth-child(3)", setupTab: "notifications", title: "Notifications", body: "Subscribe to get pushed updates: scores, results, schedule changes. Coming soon for NarWatch." },
  { selector: ".notif-card", setupTab: "schedule", title: "Notifications", body: "Subscribe to push alerts. Each alert type has its own timing — set how early you want the heads-up." },
  { selector: ".calendar-section", title: "Calendar", body: "Subscribe to the team calendar so every tournament auto-appears in your phone's calendar app." },
  { title: "Add to Home Screen", body: "Add this app to your home screen for a native app experience — Safari → Share → Add to Home Screen. No App Store required." },
  { sideEffect: "confetti", title: <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><img src="/narwhal-logo.png" alt="Narwhals" style={{ height: 32, width: "auto", verticalAlign: "middle" }} /> You&rsquo;re all set. Go Narwhals!</span>, body: "" },
];

function Tour({ step, onNext, onPrev, onSkip, onSetupTab, onConfetti }) {
  const stepData = TOUR_STEPS[step - 1];
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!stepData) return;
    if (stepData.setupTab) onSetupTab?.(stepData.setupTab);
    if (stepData.sideEffect === "confetti") onConfetti?.();
    if (!stepData.selector) {
      setRect(null);
      return;
    }
    let pulseEl = null;
    // Two-stage measurement: scroll first, then re-measure after the
    // smooth-scroll settles, so the cutout matches the post-scroll
    // bounding rect rather than the pre-scroll one.
    const initial = setTimeout(() => {
      const el = document.querySelector(stepData.selector);
      if (!el) {
        setRect(null);
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("tour-pulse");
      pulseEl = el;
      const remeasure = setTimeout(() => {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }, 350);
      // Track for cleanup via the outer return.
      pulseEl._tourRemeasure = remeasure;
    }, 50);
    return () => {
      clearTimeout(initial);
      if (pulseEl) {
        if (pulseEl._tourRemeasure) clearTimeout(pulseEl._tourRemeasure);
        pulseEl.classList.remove("tour-pulse");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (!stepData) return null;
  const total = TOUR_STEPS.length;
  return (
    <div className="tour-overlay" role="dialog" aria-label={`Tour step ${step} of ${total}`}>
      {rect ? (
        <div
          className="tour-cutout"
          style={{
            top: Math.max(rect.top - 6, 6),
            left: Math.max(rect.left - 6, 6),
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      ) : (
        <div className="tour-fullbackdrop" />
      )}
      <div className="tour-bubble">
        <div className="tour-step-num">Step {step} of {total}</div>
        <div className="tour-title">{stepData.title}</div>
        {stepData.body && <div className="tour-body">{stepData.body}</div>}
        <div className="tour-controls">
          <button className="skip-btn" onClick={onSkip}>Skip</button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 1 && <button onClick={onPrev}>← Back</button>}
            <button className="primary" onClick={onNext}>
              {step === total ? "Done" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toast({ text, onClose }) {
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(onClose, 3000);
    return () => clearTimeout(id);
  }, [text, onClose]);
  if (!text) return null;
  return (
    <div className="toast" role="status">
      <div className="toast-pill">{text}</div>
    </div>
  );
}

function InfoSheet({ data, onClose }) {
  useEffect(() => {
    if (!data) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);
  const open = Boolean(data);
  const d = data || {};
  return (
    <>
      <div className={`sheet-backdrop${open ? " open" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`sheet${open ? " open" : ""}`} role="dialog" aria-hidden={!open}>
        <div className="sheet-handle" />
        {d.title && <h3>{d.title}</h3>}
        {d.subtitle && <div className="sub">{d.subtitle}</div>}
        {(d.lines || []).map((line, i) => (
          <div key={i} className={`info-line${line.muted ? " muted" : ""}`}>
            {line.text}
          </div>
        ))}
        {d.actions && d.actions.length > 0 && (
          <div className="info-actions">
            {d.actions.map((a, i) =>
              a.href ? (
                <a key={i} className="btn-mini primary" href={a.href} target="_blank" rel="noreferrer">
                  {a.label}
                </a>
              ) : (
                <button key={i} className="btn-mini" onClick={a.onClick}>
                  {a.label}
                </button>
              )
            )}
          </div>
        )}
        <button className="sheet-close" onClick={onClose}>{d.closeLabel || "Close"}</button>
      </aside>
    </>
  );
}

function PoolGrid({ pool, onTeamTap }) {
  if (!pool || !Array.isArray(pool.teams) || pool.teams.length === 0) return null;
  return (
    <section className="pool-grid">
      <div className="pool-grid-header">
        <div className="pool-grid-title">{pool.poolName} — Narwhals' pool</div>
        {pool.matchDescription && <div className="pool-grid-sub">{pool.matchDescription}</div>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th>W</th>
            <th>L</th>
            <th>Set %</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {pool.teams.map((t) => (
            <tr
              key={t.teamId}
              className={t.isUs ? "us" : ""}
              onClick={() => onTeamTap?.(t.name)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onTeamTap?.(t.name);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <td>{t.rankText || t.rank || ""}</td>
              <td>{t.name}</td>
              <td>{t.wins}</td>
              <td>{t.losses}</td>
              <td>{Math.round((t.setPercent || 0) * 100)}%</td>
              <td>{(t.pointRatio || 0).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pool-grid-footnote">
        Round-robin match results not available
      </div>
    </section>
  );
}

function BracketCard({ match }) {
  const fts = match.sets.filter((s) => s.first > s.second).length;
  const sts = match.sets.filter((s) => s.second > s.first).length;
  const cls = [
    "bracket-card press-feedback",
    match.usPath ? "us-path" : "",
    !match.hasScores ? "pending" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={cls}>
      <div className="bracket-card-header">{match.shortName || match.fullName || ""}</div>
      <div
        className={`bracket-card-team ${match.firstTeam.won ? "won" : ""} ${match.firstTeam.isUs ? "us" : ""}`}
      >
        <span className="name" title={match.firstTeam.name}>{match.firstTeam.name}</span>
        {match.hasScores && <span className="score">{fts}</span>}
      </div>
      <div
        className={`bracket-card-team ${match.secondTeam.won ? "won" : ""} ${match.secondTeam.isUs ? "us" : ""}`}
      >
        <span className="name" title={match.secondTeam.name}>{match.secondTeam.name}</span>
        {match.hasScores && <span className="score">{sts}</span>}
      </div>
      {match.court && <div className="bracket-card-foot">{match.court}</div>}
    </article>
  );
}

function BracketTree({ bracket }) {
  const matches = bracket.matches || [];
  if (matches.length === 0) return null;
  const maxDepth = matches.reduce((m, x) => Math.max(m, x.depth), 0);
  const columns = Array.from({ length: maxDepth + 1 }, () => []);
  for (const m of matches) columns[m.depth]?.push(m);
  // Within each column, order by feedsInto so siblings under the same parent stack together.
  for (const col of columns) {
    col.sort((a, b) => String(a.feedsInto || "").localeCompare(String(b.feedsInto || "")));
  }
  // Render right-to-left: depth 0 (final) is rightmost.
  const ordered = [...columns].reverse();
  return (
    <div className="bracket-tree-wrap">
      <div className="bracket-tree-name">{bracket.name}</div>
      <div className="bracket-tree">
        {ordered.map((col, i) => (
          <div className="bracket-col" key={i}>
            {col.map((m) => (
              <BracketCard key={m.matchId} match={m} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function BracketView({ brackets }) {
  const [open, setOpen] = useState(false);
  if (!brackets || brackets.length === 0) return null;
  return (
    <div className="bracket-section">
      <button
        className="bracket-toggle press-feedback"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>
          {open ? "Hide bracket" : `View bracket${brackets.length > 1 ? "s" : ""}`}
          {brackets.length > 1 && !open ? ` (${brackets.length})` : ""}
        </span>
      </button>
      {open && brackets.map((b) => <BracketTree key={b.bracketId} bracket={b} />)}
    </div>
  );
}

function StatsAccordion({ mode, games, tz, onClose, record }) {
  if (!mode) return null;
  const filtered = (games || []).filter(
    (g) => g.done && (mode === "wins" ? g.result === "W" : g.result === "L")
  );
  // The standings-derived record (4-1 for ERVA) counts pool play matches
  // that AES doesn't expose on public endpoints. games[] only has the
  // bracket-derived matches we can pull. When the gap is non-zero, surface
  // a footnote so users aren't confused why the count differs.
  const totalForMode = mode === "wins" ? record?.wins ?? 0 : record?.losses ?? 0;
  const missing = Math.max(0, totalForMode - filtered.length);
  const tzLabel = tzShortLabel(tz);
  return (
    <section className={`stats-accordion ${mode}`} aria-live="polite">
      <div className="stats-accordion-head">
        <span>{mode === "wins" ? "Wins" : "Losses"} ({filtered.length})</span>
        <button className="stats-accordion-close" onClick={onClose} aria-label="Close list">
          ×
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="meta" style={{ padding: "10px 14px" }}>
          {missing > 0
            ? `${missing} ${mode === "wins" ? "win" : "loss"}${missing === 1 ? "" : "es"} in pool play — match details not available.`
            : `No ${mode === "wins" ? "wins" : "losses"} yet this tournament.`}
        </div>
      ) : (
        <ul className="stats-accordion-list">
          {filtered.map((g) => {
            const setsLabel = setsCountForRow(g.sets);
            const dateLabel = g.timeISO
              ? `${formatInTz(g.timeISO, tz, { weekday: "short", month: "short", day: "numeric" })}${tzLabel ? ` ${tzLabel}` : ""}`
              : g.time || "—";
            return (
              <li key={g.id}>
                <div>
                  <div className="opp">vs {g.opponent}</div>
                  <div className="meta">
                    {dateLabel} · Court {g.court || "?"}
                  </div>
                </div>
                <div className="row-score">
                  {setsLabel || (mode === "wins" ? "Won" : "Lost")}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {filtered.length > 0 && missing > 0 && (
        <div className="stats-accordion-footnote">
          + {missing} pool play {mode === "wins" ? "win" : "loss"}
          {missing === 1 ? "" : mode === "wins" ? "s" : "es"} — match details not available
        </div>
      )}
    </section>
  );
}

// Full-screen opponent history view. Renders in place of the normal
// content (chip nav, schedule, etc.) when opponentHistory is set.
// Pulls every loaded tournament's data from the cache, fetches missing
// ones in the background, then renders a season summary + per-tournament
// breakdown + a flat sortable game list.
function OpponentHistoryPage({ opponentName, tournaments, dataByTournament, loading, onBack, tz }) {
  const [filter, setFilter] = useState("all"); // 'all' | 'wins' | 'losses'
  const [sortDesc, setSortDesc] = useState(true);

  // Flatten games from every tournament where the opponent appears.
  // AES opponent names sometimes carry trailing club tags ("Foo (EV)") or
  // case differences vs. the standings teamName, so normalize before
  // comparing — case-insensitive, trimmed, ignore trailing parens.
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
  const target = norm(opponentName);
  const allGames = [];
  for (const t of tournaments) {
    if (t.static) continue;
    const data = dataByTournament[t.id];
    if (!data?.games) continue;
    for (const g of data.games) {
      if (!g.done) continue;
      if (norm(g.opponent) !== target) continue;
      allGames.push({ ...g, _tournamentId: t.id, _tournamentLabel: t.label, _tournamentDate: t.date });
    }
  }
  allGames.sort((a, b) =>
    sortDesc ? (b.timeISO || "").localeCompare(a.timeISO || "") : (a.timeISO || "").localeCompare(b.timeISO || "")
  );

  const filtered = allGames.filter(
    (g) => filter === "all" || (filter === "wins" ? g.result === "W" : g.result === "L")
  );

  // Season summary
  const wins = allGames.filter((g) => g.result === "W").length;
  const losses = allGames.filter((g) => g.result === "L").length;
  let setsWon = 0, setsLost = 0, totalUs = 0, totalThem = 0, setCount = 0;
  for (const g of allGames) {
    if (!Array.isArray(g.sets)) continue;
    for (const s of g.sets) {
      if (s.us > s.them) setsWon++;
      else if (s.them > s.us) setsLost++;
      totalUs += s.us ?? 0;
      totalThem += s.them ?? 0;
      setCount++;
    }
  }
  const avgMargin = setCount > 0 ? (totalUs - totalThem) / setCount : null;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;

  // Group by tournament for the breakdown
  const byTournament = new Map();
  for (const g of allGames) {
    if (!byTournament.has(g._tournamentId)) byTournament.set(g._tournamentId, []);
    byTournament.get(g._tournamentId).push(g);
  }

  const tzLabel = tzShortLabel(tz);

  return (
    <section className="history-page">
      <div className="history-header">
        <button className="history-back press-feedback" onClick={onBack} aria-label="Back">
          ←
        </button>
        <div className="history-title">
          <h2>{opponentName}</h2>
          <div className="sub">NIN vs {opponentName} · season history</div>
        </div>
      </div>

      {allGames.length === 0 && !loading ? (
        <div className="history-empty">
          No games found against {opponentName} in this season's data.
        </div>
      ) : (
        <>
          <section className="stats history-summary">
            <div className="stat win">
              <div className="label">Record</div>
              <div className="value">{wins}–{losses}</div>
            </div>
            <div className="stat">
              <div className="label">Quarters</div>
              <div className="value">{setsWon}–{setsLost}</div>
            </div>
            <div className="stat pos">
              <div className="label">Win rate</div>
              <div className="value">{winRate != null ? `${winRate}%` : "—"}</div>
            </div>
            <div className="stat">
              <div className="label">Avg margin</div>
              <div className="value">
                {avgMargin != null ? `${avgMargin > 0 ? "+" : ""}${avgMargin.toFixed(1)}` : "—"}
              </div>
            </div>
          </section>

          {loading && <div className="history-loading">Loading other tournaments…</div>}

          {[...byTournament.entries()].map(([tid, games]) => {
            const t = tournaments.find((x) => x.id === tid);
            return (
              <section key={tid} className="history-section">
                <div className="head">
                  <span>{t?.label || tid}</span>
                  <span>{t?.date}</span>
                </div>
                <ul className="games">
                  {games.map((g) => {
                    const dateLabel = g.timeISO
                      ? `${formatInTz(g.timeISO, tz, { weekday: "short", month: "short", day: "numeric" })}${tzLabel ? ` ${tzLabel}` : ""}`
                      : g.time || "";
                    const setsLabel = setsCountForRow(g.sets);
                    return (
                      <li key={g.id}>
                        <div>
                          <div>{dateLabel}</div>
                          <div className="meta">Court {g.court || "?"}</div>
                        </div>
                        <div className={`score ${g.result === "W" ? "win" : "loss"}`}>{setsLabel || (g.result === "W" ? "W" : "L")}</div>
                        <span className={`badge ${g.result === "W" ? "win" : "loss"}`}>{g.result === "W" ? "Won" : "Lost"}</span>
                        {Array.isArray(g.sets) && g.sets.length > 0 && (
                          <div className="sets-detail">
                            {g.sets.map((s, i) => (
                              <span key={i}>
                                {i > 0 ? ", " : ""}
                                {s.us}–{s.them}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          <div className="section-title" style={{ marginTop: 22 }}>All games</div>
          <div className="history-filter">
            {[
              ["all", "All"],
              ["wins", "Wins"],
              ["losses", "Losses"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={filter === id ? "active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => setSortDesc((s) => !s)}
              aria-label="Toggle sort order"
              style={{ marginLeft: "auto" }}
            >
              Date {sortDesc ? "↓" : "↑"}
            </button>
          </div>
          <ul className="games" style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, listStyle: "none", margin: 0, padding: 0 }}>
            {filtered.map((g) => {
              const dateLabel = g.timeISO
                ? formatInTz(g.timeISO, tz, { month: "short", day: "numeric" })
                : "—";
              const setsLabel = setsCountForRow(g.sets);
              return (
                <li
                  key={`${g._tournamentId}-${g.id}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr auto",
                    gap: 10,
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--line)",
                    alignItems: "center",
                    fontSize: 13,
                  }}
                >
                  <div className="meta">{dateLabel}</div>
                  <div style={{ minWidth: 0 }}>
                    <div>{g._tournamentLabel}</div>
                    <div className="meta">Court {g.court || "?"}</div>
                  </div>
                  <div className={`score ${g.result === "W" ? "win" : "loss"}`}>
                    {setsLabel || g.result}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function TeamPickerSheet({ teams, currentTeamId, onPick, onClose }) {
  const open = teams != null;
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={`sheet-backdrop${open ? " open" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`sheet${open ? " open" : ""}`} role="dialog" aria-hidden={!open}>
        <div className="sheet-handle" />
        <h3>Switch view</h3>
        <div className="sub">Pick any team in this division to view their schedule, record, and standings perspective.</div>
        <ul className="team-list">
          {(teams || []).map((t) => (
            <li key={t.teamId} className={String(t.teamId) === String(currentTeamId) ? "current" : ""}>
              <button onClick={() => onPick(t.teamId)}>
                <span>{t.teamName}</span>
                {t.club && <span className="team-club">{t.club}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}

function OpponentSheet({ data, onClose, onOpenHistory }) {
  // ESC to close. Mounted regardless of open state so the slide-out
  // animation works on dismiss; visual state driven by .open class.
  useEffect(() => {
    if (!data) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);

  const open = Boolean(data);
  const o = data || {};
  return (
    <>
      <div className={`sheet-backdrop${open ? " open" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`sheet${open ? " open" : ""}`} role="dialog" aria-hidden={!open}>
        <div className="sheet-handle" />
        <h3>{o.name || ""}</h3>
        <div className="sub">
          {o.isUs ? "Season summary" : o.club || "—"}
        </div>
        {o.isUs ? (
          <>
            <div className={`stat-row${o.seasonWins > o.seasonLosses ? " win" : o.seasonLosses > o.seasonWins ? " loss" : ""}`}>
              <span className="stat-label">Tournament record</span>
              <span className="stat-value">{o.seasonWins}–{o.seasonLosses}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Sets</span>
              <span className="stat-value">
                {o.setsWon != null ? `${o.setsWon}–${o.setsLost}` : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Set %</span>
              <span className="stat-value">
                {o.setPercent != null ? `${Math.round(o.setPercent * 100)}%` : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Avg margin / set</span>
              <span className="stat-value">
                {o.avgMargin != null ? `${o.avgMargin > 0 ? "+" : ""}${o.avgMargin.toFixed(1)}` : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Pool rank</span>
              <span className="stat-value">{o.rankText || (o.rank ? `#${o.rank}` : "—")}</span>
            </div>
          </>
        ) : (
          <>
            <div className={`stat-row${o.h2hWins > o.h2hLosses ? " win" : o.h2hLosses > o.h2hWins ? " loss" : ""}`}>
              <span className="stat-label">Head-to-head this season</span>
              <span className="stat-value">
                {o.h2hWins}–{o.h2hLosses}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Pool record</span>
              <span className="stat-value">
                {o.poolWins != null ? `${o.poolWins}–${o.poolLosses}` : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Pool rank</span>
              <span className="stat-value">{o.rankText || (o.rank ? `#${o.rank}` : "—")}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Set %</span>
              <span className="stat-value">
                {o.setPercent != null ? `${Math.round(o.setPercent * 100)}%` : "—"}
              </span>
            </div>
          </>
        )}
        {!o.isUs && o.name && o.name !== "TBD" && onOpenHistory && (
          <button className="history-link press-feedback" onClick={() => onOpenHistory(o.name)}>
            See full history →
          </button>
        )}
        <button className="sheet-close" onClick={onClose}>Close</button>
      </aside>
    </>
  );
}

// Work-duty sticky banner removed — water polo doesn't have parent
// work-team rotations like volleyball does. The DutySticky component
// and its render are gone for v1.

// LeaderboardTab, PlayerSheet, H2HSheet → components/LeaderboardCluster.jsx (GH#11)

// ─────────────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tournamentId, setTournamentId] = usePersistentState("tournamentId", TOURNAMENTS[TOURNAMENTS.length - 1].id);
  // Always open on the latest tournament — override any stale localStorage value.
  // usePersistentState hydrates from localStorage after mount; this effect fires
  // after it (effects run in declaration order) and wins.
  useEffect(() => {
    setTournamentId(TOURNAMENTS[TOURNAMENTS.length - 1].id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [themeId, setThemeId] = usePersistentState("themeId", "narwhal");
  const tournament = TOURNAMENTS.find((t) => t.id === tournamentId) || TOURNAMENTS[0];
  // Latest tournamentId, readable from async effect closures that captured an
  // initial-render value. usePersistentState rehydrates from localStorage after
  // mount, so the niwp-weeks resolver needs this to honor PWA cold-load
  // selections that have no #tournament hash to fall back on.
  const tournamentIdRef = useRef(tournamentId);
  useEffect(() => { tournamentIdRef.current = tournamentId; }, [tournamentId]);
  const [teamId, setTeamId] = usePersistentState(
    `teamId-${tournament.id}`,
    tournament.teamId
  );

  // NIWP multi-week state:
  //   niwpWeeks  – null while loading, array of {weekKey,chipLabel,label,...} when ready
  //   niwpWeekKey – null = show most recent week; string = specific week key selected
  const [niwpWeeks, setNiwpWeeks] = useState(null);
  const [niwpWeekKey, setNiwpWeekKey] = useState(null);
  const [niwpFetchSettled, setNiwpFetchSettled] = useState(false);
  const [hashHydrated, setHashHydrated] = useState(false);

  // Schedule team filter: "all" | "B" | "G" | "BJV" | "GJV" | "D"
  const [scheduleTeamFilter, setScheduleTeamFilter] = useState("all");

  // Timezone override: "venue" = show times in the venue's timezone (default),
  //                   "local" = show in user's device timezone.
  const [tzOverride, setTzOverride] = usePersistentState("tzOverride", "venue");

  const [data, setData] = useState(null);
  // Static tournaments have no API fetch — don't start in loading state.
  const [loading, setLoading] = useState(!tournament.static);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("schedule");
  const [changedIds, setChangedIds] = useState(new Set());
  const [recentWinIds, setRecentWinIds] = useState(new Set());
  const [winToast, setWinToast] = useState(null);
  const [lastLiveChange, setLastLiveChange] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [opponentSheet, setOpponentSheet] = useState(null);
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);

  // A2HS install handling. Chrome/Android fires beforeinstallprompt;
  // iOS Safari does not, so we fall back to an instructional sheet.
  const installPromptRef = useRef(null);
  const [installPromptable, setInstallPromptable] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator?.standalone === true;
    setIsStandalone(Boolean(standalone));
    function handler(e) {
      e.preventDefault();
      installPromptRef.current = e;
      setInstallPromptable(true);
    }
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  function showA2HSInstructions() {
    const isApple =
      typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || "");
    if (isApple) {
      setInfoSheet({
        title: "Add to Home Screen",
        subtitle: "iOS Safari",
        lines: [
          { text: "1. Tap the Share button (⎙) in Safari's toolbar." },
          { text: "2. Scroll down and tap 'Add to Home Screen'." },
          { text: "3. Tap Add. The app launches like a native app from your home screen." },
          { text: "Notifications and many features only work in standalone mode.", muted: true },
        ],
        closeLabel: "Got it",
      });
      return;
    }
    setInfoSheet({
      title: "Add to Home Screen",
      lines: [
        { text: "Open this page's browser menu and choose 'Add to Home Screen' or 'Install app'." },
      ],
      closeLabel: "Got it",
    });
  }

  async function handleInstallTap() {
    if (isStandalone) {
      setToast("Already installed");
      return;
    }
    const evt = installPromptRef.current;
    if (evt && installPromptable) {
      try {
        evt.prompt();
        const choice = await evt.userChoice;
        installPromptRef.current = null;
        setInstallPromptable(false);
        if (choice?.outcome === "accepted") setToast("Installed");
      } catch {}
      return;
    }
    showA2HSInstructions();
  }

  async function handleShareApp() {
    const payload = {
      title: "North Idaho Narwhals Tracker",
      text: "Live scores & schedule for North Idaho Narwhals water polo",
      url: typeof window !== "undefined" ? window.location.origin : "https://narwatch.vercel.app",
    };
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        return;
      } catch {
        /* user cancelled */
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(payload.url);
        setToast("Link copied!");
      } catch {
        setToast(payload.url);
      }
    }
  }
  // Leaderboard state — lazy-loaded when the stats tab is first opened
  const [leaderboardData, setLeaderboardData]       = useState(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [playerSheet, setPlayerSheet]               = useState(null);

  // H2H sheet — lazily loads all games once and caches them
  const [h2hSheet, setH2hSheet]             = useState(null); // null | opponent name string
  const [h2hHasOpened, setH2hHasOpened]     = useState(false); // true once sheet first opened; keeps component mounted for exit animation (GH#18)
  const [allGamesCache, setAllGamesCache]   = useState(null); // null | game[]
  const [h2hGamesLoading, setH2hGamesLoading] = useState(false);

  useEffect(() => {
    if (tab !== "stats" || leaderboardData || leaderboardLoading) return;
    setLeaderboardLoading(true);
    fetch("/api/historical?view=player_stats")
      .then((r) => r.json())
      .then((json) => setLeaderboardData(json?.player_season_stats ?? null))
      .catch(() => {/* silently degrade */})
      .finally(() => setLeaderboardLoading(false));
  }, [tab, leaderboardData, leaderboardLoading]);

  const [statsAccordion, setStatsAccordion] = useState(null); // 'wins' | 'losses' | null
  const [toast, setToast] = useState(null);
  const [infoSheet, setInfoSheet] = useState(null);
  const [userRefreshing, setUserRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [tourSeen, setTourSeen] = usePersistentState("tourSeen", false);
  const [tourNudgeDismissed, setTourNudgeDismissed] = usePersistentState("tourNudgeDismissed", false);
  const [opponentHistory, setOpponentHistory] = useState(null); // opponent name | null
  const [historyData, setHistoryData] = useState({}); // tournamentId -> payload
  const [historyLoading, setHistoryLoading] = useState(false);

  async function openOpponentHistory(name) {
    setOpponentSheet(null);
    setOpponentHistory(name);
    // Seed cache with current tournament's data so the page renders immediately.
    const initial = {};
    if (data && tournament && !tournament.static) {
      initial[tournament.id] = data;
    }
    setHistoryData(initial);
    setHistoryLoading(true);
    // Fetch missing tournaments in parallel.
    const todo = TOURNAMENTS.filter(
      (t) => !t.static && !initial[t.id]
    );
    await Promise.all(
      todo.map(async (t) => {
        try {
          const url = buildTournamentUrl({ eventId: t.eventId, divId: t.divId, teamId: t.teamId, teamName: t.teamName });
          const res = await fetch(url);
          if (!res.ok) return;
          const json = await res.json();
          setHistoryData((prev) => ({ ...prev, [t.id]: json }));
        } catch {}
      })
    );
    setHistoryLoading(false);
  }

  function startTour() {
    setTourStep(1);
    setTourSeen(true);
    setTourNudgeDismissed(true);
  }
  function nextTourStep() {
    setTourStep((s) => {
      if (s >= TOUR_STEPS.length) return 0;
      return s + 1;
    });
  }
  function prevTourStep() {
    setTourStep((s) => Math.max(1, s - 1));
  }

  function showCourtInfo(court, venue) {
    if (!court) return;
    const lines = [];
    if (venue?.name) lines.push({ text: venue.name });
    if (venue?.address) lines.push({ text: venue.address, muted: true });
    if (!venue?.name && !venue?.address) lines.push({ text: "Venue information not available.", muted: true });
    const mapHref = venue?.address ? mapsHrefFor(`${venue.name || ""} ${venue.address || ""}`.trim()) : null;
    setInfoSheet({
      title: `Court ${court}`,
      lines,
      actions: mapHref ? [{ label: "📍 Open in Maps", href: mapHref }] : [],
    });
  }

  function showProjectedDoneToast() {
    setToast("Estimated based on scheduled end times. Actual may vary.");
  }

  function showCountdownInfo() {
    if (!tournament || !tournamentMeta) return;
    setInfoSheet({
      title: tournamentMeta.name || tournament.label,
      subtitle: tournamentDateRange,
      lines: [
        tournamentMeta.location ? { text: `📍 ${tournamentMeta.location}` } : null,
        tournament.venue?.address ? { text: tournament.venue.address, muted: true } : null,
      ].filter(Boolean),
      actions: tournament.venue?.address
        ? [{ label: "📍 Open in Maps", href: mapsHrefFor(`${tournament.venue.name || ""} ${tournament.venue.address || ""}`) }]
        : [],
    });
  }
  const prevDataRef = useRef(null);
  const prevLiveRef = useRef(null);
  const firstLoadRef = useRef(true);
  const [origin, setOrigin] = useState("");

  function toggleExpanded(id) {
    setExpandedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openOpponent(name) {
    if (!name || !data) return;
    const games = data.games || [];
    const row = (data.standings || []).find((s) => s.teamName === name);
    const isUs = row?.isUs || name === teamName;

    if (isUs) {
      // Season summary for the viewing team — total record, set %, avg
      // per-set margin computed from played games' sets[].
      let totalUs = 0, totalThem = 0, setCount = 0;
      for (const g of games) {
        if (!g.done || !Array.isArray(g.sets)) continue;
        for (const s of g.sets) {
          totalUs += s.us ?? 0;
          totalThem += s.them ?? 0;
          setCount++;
        }
      }
      const avgMargin = setCount > 0 ? (totalUs - totalThem) / setCount : null;
      setOpponentSheet({
        isUs: true,
        name: teamName,
        club: row?.club || null,
        seasonWins: data.record?.wins ?? row?.matchesWon ?? 0,
        seasonLosses: data.record?.losses ?? row?.matchesLost ?? 0,
        setsWon: row?.setsWon ?? null,
        setsLost: row?.setsLost ?? null,
        setPercent: row?.setPercent ?? null,
        rankText: row?.rankText ?? null,
        rank: row?.rank ?? null,
        avgMargin,
      });
      return;
    }

    let h2hWins = 0, h2hLosses = 0;
    for (const g of games) {
      if (g.opponent !== name || !g.done) continue;
      if (g.result === "W") h2hWins++;
      else if (g.result === "L") h2hLosses++;
    }
    setOpponentSheet({
      isUs: false,
      name,
      club: row?.club || null,
      h2hWins,
      h2hLosses,
      poolWins: row?.matchesWon ?? null,
      poolLosses: row?.matchesLost ?? null,
      rank: row?.rank ?? null,
      rankText: row?.rankText ?? null,
      setPercent: row?.setPercent ?? null,
    });
  }

  // ── openH2H ────────────────────────────────────────────────────────────────
  // Opens the H2H sheet for the given opponent name. Lazily fetches
  // /api/historical?view=games on first call and caches the full game list.
  async function openH2H(opponentName) {
    if (!opponentName) return;
    setH2hHasOpened(true);
    setH2hSheet(opponentName);
    if (!allGamesCache && !h2hGamesLoading) {
      setH2hGamesLoading(true);
      try {
        const r = await fetch("/api/historical?view=games");
        if (r.ok) {
          const json = await r.json();
          setAllGamesCache(json.games || []);
        }
      } catch {
        // silently degrade — sheet will show "no games found"
      }
      setH2hGamesLoading(false);
    }
  }

  // ── hash routing ───────────────────────────────────────────────────────────
  // On mount, restore #tournament=<id|weekKey> for the static-fallback chip
  // row, and #h2h=<slug> by resolving the slug against the historical cache.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = readHashParams();
    let cancelled = false;
    if (hash.tournament) {
      const t = TOURNAMENTS.find((x) => x.id === hash.tournament);
      if (t) {
        setTournamentId(t.id);
        if (!t.static) setTeamId(t.teamId);
      }
      // If hash.tournament doesn't match a static TOURNAMENTS id, the
      // niwp-weeks fetch effect resolves it as a weekKey instead.
    }
    if (hash.h2h) {
      (async () => {
        let cache = allGamesCache;
        if (!cache) {
          setH2hGamesLoading(true);
          try {
            const r = await fetch("/api/historical?view=games");
            if (r.ok) {
              const json = await r.json();
              cache = json.games || [];
              if (!cancelled) setAllGamesCache(cache);
            }
          } catch {}
          if (!cancelled) setH2hGamesLoading(false);
        }
        if (cancelled || !cache) return;
        const match = cache.find(
          (g) =>
            slugifyHashValue(g.opponent_display_name) === hash.h2h ||
            slugifyHashValue(g.away_team) === hash.h2h
        );
        if (match) setH2hSheet(match.opponent_display_name || match.away_team);
      })();
    }
    setHashHydrated(true);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state → hash. Runs whenever tournament selection or H2H sheet changes,
  // but only after the initial hash has been read AND the niwp-weeks fetch has
  // settled (so we know whether NIWP mode is active and which value to write).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hashHydrated || !niwpFetchSettled) return;
    const parts = [];
    // niwp mode + niwpWeekKey set → write weekKey
    // niwp mode + niwpWeekKey null  → static tournament selected, write tournamentId
    // no niwp mode                  → write tournamentId
    const tournamentValue = niwpWeeks
      ? (niwpWeekKey ?? tournamentId)
      : tournamentId;
    if (tournamentValue) parts.push(`tournament=${encodeURIComponent(tournamentValue)}`);
    if (h2hSheet) parts.push(`h2h=${encodeURIComponent(slugifyHashValue(h2hSheet))}`);
    const newHash = parts.length ? `#${parts.join("&")}` : "";
    if (newHash !== window.location.hash) {
      const url = window.location.pathname + window.location.search + newHash;
      window.history.replaceState(null, "", url || window.location.pathname);
    }
  }, [hashHydrated, niwpFetchSettled, niwpWeeks, niwpWeekKey, tournamentId, h2hSheet]);

  // Filtered + annotated games for the current H2H opponent.
  // home_team is always CDA (convention from compute-aggregates.js).
  const h2hGames = useMemo(() => {
    if (!h2hSheet || !allGamesCache) return null;
    const norm = (s) =>
      String(s || "").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
    const target = norm(h2hSheet);
    const filtered = allGamesCache.filter(
      (g) =>
        norm(g.opponent_display_name) === target ||
        norm(g.away_team) === target
    );
    return filtered
      .map((g) => {
        const narwhalScore = parseInt(g.home_score) || 0;
        const oppScore     = parseInt(g.away_score) || 0;
        const result = narwhalScore > oppScore ? "W" : narwhalScore < oppScore ? "L" : "T";
        const goalDiff = narwhalScore - oppScore;
        const dateLabel = g.game_date
          ? new Date(g.game_date).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })
          : "—";
        return { ...g, _result: result, _narwhalScore: narwhalScore, _oppScore: oppScore, _goalDiff: goalDiff, _dateLabel: dateLabel };
      })
      .sort((a, b) => (b.game_date || "").localeCompare(a.game_date || ""));
  }, [h2hSheet, allGamesCache]);

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  // Auto-reload when a new service worker activates, so users immediately
  // get the fresh HTML shell and JS bundle without a manual refresh.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    function onSwMessage(evt) {
      if (evt.data?.type === "SW_UPDATED") window.location.reload();
    }
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onSwMessage);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (themeId === "default") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", themeId);
  }, [themeId]);

  const teamName = useMemo(() => {
    const t = data?.teams?.find((x) => String(x.teamId) === String(teamId));
    return t?.teamName || tournament.teamName;
  }, [data, teamId, tournament.teamName]);

  const load = useCallback(
    async (force = false) => {
      if (force) setUserRefreshing(true);
      hydrateCacheFromLocalStorage();

      // Static-tournament early bail: applies when NIWP is absent, OR when a
      // static-only tournament is selected in NIWP mode (niwpWeekKey === null
      // sentinel — set by clicking a static chip whose weekKey isn't in NIWP).
      if (tournament.static && (!niwpWeeks || niwpWeekKey === null)) {
        prevDataRef.current = null;
        prevLiveRef.current = null;
        firstLoadRef.current = true;
        setData(null);
        setError(null);
        setLoading(false);
        if (force) {
          setUserRefreshing(false);
          setRefreshDone(true);
          setTimeout(() => setRefreshDone(false), 2000);
        }
        return;
      }

      // Build fetch URL (without force flag — we key the cache on the clean URL).
      // buildTournamentUrl omits eventId/divId when undefined (static tournaments
      // use NIWP via weekKey and don't carry these fields — GH#4).
      const url = buildTournamentUrl({
        eventId:  tournament.eventId,
        divId:    tournament.divId,
        teamId,
        teamName,
        weekKey:  niwpWeeks && niwpWeekKey ? niwpWeekKey : undefined,
      });

      // ── Client-side cache check ─────────────────────────────────────────────
      if (!force) {
        const entry = CLIENT_DATA_CACHE.get(url);
        if (entry) {
          const age = Date.now() - entry.fetchedAt;
          if (age < CLIENT_CACHE_TTL_MS) {
            // Fresh cache hit — render instantly, skip network entirely.
            setData(entry.payload);
            setLoading(false);
            return;
          }
          // Stale — show cached data immediately so switching feels instant,
          // then re-fetch silently in the background (no spinner).
          setData(entry.payload);
          setLoading(false);
          // fall through to fetch below (no setLoading(true))
        }
      }

      // Only show the loading spinner when there is nothing yet to display.
      const hasStaleFallback = !force && CLIENT_DATA_CACHE.has(url);
      if (!hasStaleFallback) setLoading(true);

      try {
        const fetchUrl = force ? `${url}&force=1` : url;
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const next = await res.json();

        // Populate / overwrite client cache (memory + localStorage).
        writeCache(url, next);

        const changed = detectChangedIds(prevDataRef.current, next);
        if (changed.size) setChangedIds(changed);

        if (!firstLoadRef.current) {
          const newWins = detectNewWins(prevDataRef.current, next);
          if (newWins.length) {
            setRecentWinIds((s) => {
              const out = new Set(s);
              for (const w of newWins) out.add(w.id);
              return out;
            });
            setWinToast(newWins[0]);
            celebrate(themeId);
            setTimeout(() => setWinToast(null), 6000);
            setTimeout(
              () =>
                setRecentWinIds((s) => {
                  const out = new Set(s);
                  for (const w of newWins) out.delete(w.id);
                  return out;
                }),
              10_000
            );
          }
        }

        const prevLive = prevLiveRef.current;
        const curLive = next.liveGame;
        if (curLive) {
          const sig = JSON.stringify(curLive.rawSets || []);
          if (!prevLive || prevLive.sig !== sig) {
            setLastLiveChange(Date.now());
            prevLiveRef.current = { sig };
          }
        } else {
          prevLiveRef.current = null;
          setLastLiveChange(null);
        }

        prevDataRef.current = next;
        firstLoadRef.current = false;
        setData(next);
        setError(null);

        if (typeof navigator !== "undefined" && navigator.vibrate && force) {
          navigator.vibrate(40);
        }
      } catch (e) {
        // Don't clobber visible stale data with an error message.
        if (!hasStaleFallback) setError(String(e.message || e));
      } finally {
        setLoading(false);
        if (force) { setUserRefreshing(false); setRefreshDone(true); setTimeout(() => setRefreshDone(false), 2000); }
      }
    },
    [tournament.eventId, tournament.divId, teamId, teamName, themeId, niwpWeeks, niwpWeekKey]
  );

  // Gate the first fetch on niwpFetchSettled so we don't fire twice:
  // once with no weekKey, then again ~1.5s later when /api/niwp-weeks resolves
  // and changes the URL. Once settled, niwpWeekKey is stable and load() runs once.
  // Static tournaments bypass the gate — they have no API fetch and shouldn't
  // wait ~1.5s for NIWP to settle before rendering their schedule.
  useEffect(() => {
    if (!niwpFetchSettled && !tournament.static) return;
    firstLoadRef.current = true;
    prevDataRef.current = null;
    load();
  }, [load, niwpFetchSettled, tournament.static]);

  // Hydrate niwpWeeks from localStorage on mount so the niwpFetchSettled gate
  // fires immediately for returning users — eliminating the fetch waterfall.
  // The background fetch below always runs to refresh (SWR semantics). GH#10.
  useEffect(() => {
    const cached = readCachedNiwpWeeks();
    if (!Array.isArray(cached) || cached.length === 0) return;
    const niwpKeys = new Set(cached.map((w) => w.weekKey));
    const hashTour = readHashParams().tournament;
    const matchedWeek = hashTour && cached.find((w) => w.weekKey === hashTour);
    const matchedStatic = hashTour && TOURNAMENTS.find((t) => t.id === hashTour);
    const persistedStatic = !hashTour && TOURNAMENTS.find(
      (t) => t.id === tournamentIdRef.current && t.static && t.weekKey && !niwpKeys.has(t.weekKey) && isWeekKeyRecent(t.weekKey)
    );
    setNiwpWeeks(cached);
    setNiwpWeekKey(
      matchedWeek
        ? matchedWeek.weekKey
        : (matchedStatic || persistedStatic)
          ? null
          : cached[cached.length - 1].weekKey
    );
    setNiwpFetchSettled(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch available NIWP tournament weeks once on mount (and if force-refresh).
  // When the server has NIWP_API_ENABLED=true, this populates the dynamic chip
  // row. If the endpoint returns [] (NIWP disabled) or errors, niwpWeeks stays
  // null and the static TOURNAMENTS chip row is used as the fallback.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/niwp-weeks")
      .then((r) => r.ok ? r.json() : null)
      .then((weeks) => {
        if (!cancelled && Array.isArray(weeks) && weeks.length > 0) {
          persistNiwpWeeks(weeks);
          setNiwpWeeks(weeks);
          // Honor #tournament=<weekKey | staticId> if present; otherwise
          // consult the LS-restored tournamentId for a static-only fallback
          // (PWA cold loads have no hash); otherwise default to the most
          // recent week (last in sorted list). niwpWeekKey === null sentinel
          // = a static-only tournament is selected in NIWP mode (e.g. Orlando
          // before NIWP has W20 data).
          const niwpKeys = new Set(weeks.map((w) => w.weekKey));
          const hashTour = readHashParams().tournament;
          const matchedWeek = hashTour && weeks.find((w) => w.weekKey === hashTour);
          const matchedStatic = hashTour && TOURNAMENTS.find((t) => t.id === hashTour);
          const persistedStatic = !hashTour && TOURNAMENTS.find(
            // Also require isWeekKeyRecent so a persisted static chip whose
            // weekKey is long past (>4 weeks) doesn't silently restore (GH#7).
            (t) => t.id === tournamentIdRef.current && t.static && t.weekKey && !niwpKeys.has(t.weekKey) && isWeekKeyRecent(t.weekKey)
          );
          setNiwpWeekKey(
            matchedWeek
              ? matchedWeek.weekKey
              : (matchedStatic || persistedStatic)
                ? null
                : weeks[weeks.length - 1].weekKey
          );
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setNiwpFetchSettled(true); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefetch all NIWP weeks in the background once the week list loads.
  // Runs once (1.5 s after niwpWeeks first arrives) so the current week
  // renders first. Skips any URL already in the client cache. Rate-limited
  // at 300 ms between requests to avoid hammering the server.
  useEffect(() => {
    if (!niwpWeeks || niwpWeeks.length < 2) return;
    let cancelled = false;
    const currentKey = niwpWeekKey ?? niwpWeeks[niwpWeeks.length - 1]?.weekKey;
    const others = niwpWeeks.filter((w) => w.weekKey !== currentKey);

    const prefetch = async () => {
      for (const week of others) {
        if (cancelled) break;
        const wUrl = buildTournamentUrl({
          eventId:  tournament.eventId,
          divId:    tournament.divId,
          teamId,
          teamName,
          weekKey:  week.weekKey,
        });
        if (CLIENT_DATA_CACHE.has(wUrl)) continue; // already warm
        try {
          const res = await fetch(wUrl);
          if (!cancelled && res.ok) {
            const payload = await res.json();
            writeCache(wUrl, payload); // persist prefetched weeks to disk too
          }
        } catch {} // silently skip failed prefetches
        if (!cancelled) await new Promise((r) => setTimeout(r, 300));
      }
    };

    const timer = setTimeout(prefetch, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [niwpWeeks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adaptive poll interval — driven by _pollSchedule from the NIWP API.
  // Falls back to DEFAULT_REFRESH_MS until first data arrives or for non-NIWP sources.
  // Modes: live (90s) → hot (3m) → cooldown (5m) → warm (10m) → cold (4h).
  const pollIntervalMs = data?._pollSchedule?.intervalMs ?? DEFAULT_REFRESH_MS;
  useInterval(() => load(), pollIntervalMs);

  // Timezone: the NIWP API returns venueTz (inferred from location). Fall back
  // to the static tournament config's tz if that's not present.
  const venueTz = data?.venueTz || tournament.venue?.tz || "America/Los_Angeles";
  // activeTz: undefined means "device local time" (no timeZone in Intl options).
  const activeTz = tzOverride === "local" ? undefined : venueTz;
  // Short label to show next to times, e.g. "PT". Omit in local mode.
  const activeTzLabel = tzOverride === "local" ? null : tzShortLabel(venueTz);

  const games = data?.games || [];
  // Only show the team filter when ≥2 subteams are tagged in games[]. With
  // 0 or 1 subteams represented, the dropdown is either useless or would
  // produce zero-result filter options.
  const availableSubteams = useMemo(() => {
    const s = new Set();
    for (const g of games) if (g.subteam) s.add(g.subteam);
    return s;
  }, [games]);
  const showTeamFilter = availableSubteams.size >= 2;
  const effectiveTeamFilter =
    scheduleTeamFilter === "all" || availableSubteams.has(scheduleTeamFilter)
      ? scheduleTeamFilter
      : "all";
  const visibleGames = effectiveTeamFilter === "all"
    ? games
    : games.filter((g) => g.subteam === effectiveTeamFilter);
  const pastGames = visibleGames.filter((g) => g.done);
  const upcomingGames = visibleGames.filter((g) => !g.done);
  const standings = data?.standings || [];
  const standingsById = useMemo(() => {
    const m = new Map();
    for (const s of standings) m.set(s.teamName, s);
    return m;
  }, [standings]);
  const record = data?.record || { wins: 0, losses: 0 };
  const teamsList = data?.teams || [];

  const nextEvent = data?.nextEvent || null;
  const minutesUntil = useCountdown(nextEvent?.timeISO);

  const tournamentMeta = data?.event || null;
  const tournamentName = tournamentMeta?.name || tournament.label;
  const tournamentLocation = tournamentMeta?.location || tournament.venue?.name || null;
  const tournamentDateRange = useMemo(() => {
    if (!tournamentMeta?.startDate) return tournament.date;
    const opts = { month: "short", day: "numeric" };
    const s = new Date(tournamentMeta.startDate).toLocaleDateString("en-US", opts);
    const e = tournamentMeta.endDate
      ? new Date(tournamentMeta.endDate).toLocaleDateString("en-US", opts)
      : null;
    return e && e !== s ? `${s}–${e}` : s;
  }, [tournamentMeta, tournament.date]);
  const eventOver = tournamentMeta?.isOver === true;

  function shareGame(g) {
    const text = g.result === "W"
      ? `${teamName} def. ${g.opponent}${g.score ? ` ${g.score}` : ""} 🏐`
      : `${teamName} fell to ${g.opponent}${g.score ? ` ${g.score}` : ""}`;
    const full = `${text} #NarwhalWaterPolo #waterpolo`;
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({ title: "NarWatch", text: full }).catch(() => {});
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(full).then(() => alert("Copied")).catch(() => {});
    }
  }

  function addCalSingle(g) {
    const ics = buildSingleICS(g, teamName);
    if (!ics) return;
    const slug = (g.opponent || "game").replace(/\s+/g, "_");
    downloadICS(`narwhal-${slug}.ics`, ics);
  }

  async function shareSummary() {
    const lines = [];
    lines.push(`${teamName} — ${record.wins}W ${record.losses}L`);
    if (data?.goalDiff != null) lines.push(`Goal diff: ${data.goalDiff > 0 ? "+" : ""}${data.goalDiff}`);
    if (data?.liveGame) {
      lines.push(`LIVE: ${data.liveGame.us}-${data.liveGame.them} (Set ${data.liveGame.setNumber})`);
    } else if (nextEvent) {
      const what = nextEvent.kind === "work" ? nextEvent.role : `vs ${nextEvent.opponent}`;
      lines.push(`Next: ${nextEvent.time} · Court ${nextEvent.court} · ${what}`);
    }
    const text = lines.join("\n");
    try {
      if (navigator.share) await navigator.share({ title: "NarWatch", text });
      else {
        await navigator.clipboard.writeText(text);
        alert("Copied to clipboard");
      }
    } catch {}
  }

  return (
    <>
      <Head>
        <title>NarWatch</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      </Head>
      <div className="app">
        {opponentHistory ? (
          <OpponentHistoryPage
            opponentName={opponentHistory}
            tournaments={TOURNAMENTS}
            dataByTournament={historyData}
            loading={historyLoading}
            tz={activeTz}
            onBack={() => setOpponentHistory(null)}
          />
        ) : (
        <>
        <header className="header-compact">
          <div className="team-name" title="North Idaho Narwhals">
            <img src="/narwhal-logo.png" alt="North Idaho Narwhals" className="header-logo" />
            <span className="header-brand">NarWatch</span>
          </div>
          {data?.liveGame && (
            <span className="live-pill" aria-label="Live game">
              <span className="live-dot" /> LIVE
            </span>
          )}
          <div className="header-compact-actions">
            <button
              className={`icon-only-btn refresh-btn${userRefreshing ? " spinning" : ""}${refreshDone ? " done" : ""}`}
              onClick={() => { if (!userRefreshing) load(true); }}
              aria-label="Refresh"
              title="Refresh data"
              disabled={userRefreshing}
            >
              {refreshDone ? "✓" : "↻"}
            </button>
            <button
              className={`icon-only-btn${isStandalone ? " installed" : ""}`}
              onClick={handleInstallTap}
              aria-label={isStandalone ? "Already installed" : "Add to Home Screen"}
              title={isStandalone ? "Already installed" : "Add to Home Screen"}
              disabled={isStandalone && !installPromptable}
            >
              {isStandalone ? "✓" : "⊕"}
            </button>
            <button
              className="icon-only-btn"
              onClick={handleShareApp}
              aria-label="Share app"
              title="Share app"
            >
              ↗
            </button>
            <button
              className="icon-only-btn"
              onClick={startTour}
              aria-label="Demo tour"
              title="Demo tour"
            >
              ▶
            </button>
          </div>
        </header>

        {!tourSeen && !tourNudgeDismissed && tourStep === 0 && (
          <div className="tour-nudge">
            <span>New here? Take a quick demo tour →</span>
            <button onClick={startTour}>Start</button>
            <button className="dismiss" onClick={() => setTourNudgeDismissed(true)} aria-label="Dismiss nudge">
              ×
            </button>
          </div>
        )}

        <div className="chip-row" role="tablist" aria-label="Tournaments">
          {niwpWeeks
            ? /* NIWP mode: render static-only tournaments (whose weekKey is
                 not yet covered by NIWP) leftmost as forward-looking
                 placeholders, then NIWP weeks newest-leftmost. niwpWeekKey
                 null = a static-only chip is active. */
              (() => {
                const niwpKeys = new Set(niwpWeeks.map((w) => w.weekKey));
                const staticOnly = TOURNAMENTS.filter(
                  // isWeekKeyRecent: hide chips whose tournament ended >4 weeks
                  // ago so stale static entries don't re-surface when NIWP
                  // data no longer covers that week (GH#7).
                  (t) => t.static && t.weekKey && !niwpKeys.has(t.weekKey) && isWeekKeyRecent(t.weekKey)
                );
                return (
                  <>
                    {staticOnly.map((t) => {
                      const isActive = niwpWeekKey === null && tournamentId === t.id;
                      return (
                        <button
                          key={t.id}
                          id={`chip-${t.id}`}
                          className={`chip${isActive ? " active" : ""}`}
                          onClick={() => {
                            setTournamentId(t.id);
                            setNiwpWeekKey(null);
                          }}
                          role="tab"
                          aria-selected={isActive ? "true" : "false"}
                          aria-controls="tournament-panel"
                          tabIndex={isActive ? 0 : -1}
                        >
                          {t.chipLabel || t.label}
                        </button>
                      );
                    })}
                    {niwpWeeks.slice().reverse().map((w) => {
                      const isActive = w.weekKey === niwpWeekKey;
                      return (
                        <button
                          key={w.weekKey}
                          id={`chip-niwp-${w.weekKey}`}
                          className={`chip${isActive ? " active" : ""}`}
                          onClick={() => setNiwpWeekKey(w.weekKey)}
                          role="tab"
                          aria-selected={isActive ? "true" : "false"}
                          aria-controls="tournament-panel"
                          tabIndex={isActive ? 0 : -1}
                        >
                          {w.chipLabel}
                        </button>
                      );
                    })}
                  </>
                );
              })()
            : /* Fallback: static TOURNAMENTS list (used when NIWP disabled) */
              TOURNAMENTS.map((t) => (
                <button
                  key={t.id}
                  id={`chip-${t.id}`}
                  className={`chip${tournamentId === t.id ? " active" : ""}`}
                  onClick={() => {
                    setTournamentId(t.id);
                    if (!t.static) setTeamId(t.teamId);
                  }}
                  role="tab"
                  aria-selected={tournamentId === t.id ? "true" : "false"}
                  aria-controls="tournament-panel"
                  tabIndex={tournamentId === t.id ? 0 : -1}
                >
                  {t.chipLabel || t.label}
                </button>
              ))
          }
        </div>

        <div
          id="tournament-panel"
          role="tabpanel"
          aria-labelledby={`chip-${tournament.id}`}
        >
        {!tournament.static && teamsList.length > 0 && (
          <div className="view-as-row">
            <span>Viewing as:</span>
            <button
              className="view-as-pill press-feedback"
              onClick={() => setTeamPickerOpen(true)}
              aria-label="Switch viewing-as team"
            >
              <span>{teamName}</span>
              <span className="chev">▾</span>
            </button>
          </div>
        )}

        {tournament.static && (!niwpWeeks || niwpWeekKey === null) ? (
          <StaticTournamentCard tournament={tournament} />
        ) : (
          <>
        {data?.liveGame && (
          <LiveScoreBanner
            live={data.liveGame}
            lastChangedAt={lastLiveChange}
            watchUrl={data.liveGame?.videoLink || data.teamWatchNowLink || null}
          />
        )}

        {(() => {
          // Don't show the stat bar at all when the tournament hasn't
          // started — let the countdown card do the talking. Show
          // individual stat cards only when they have data: hide zero
          // wins / losses; goal diff hides until at least one game played.
          const showWins = record.wins > 0;
          const showLosses = record.losses > 0;
          const goalDiff = data?.goalDiff ?? 0;
          const hasGames = (data?.games || []).some((g) => g.done);
          const showGoalDiff = hasGames;
          const eventStarted = !data?.event?.startDate
            ? Boolean(data?.games?.length || data?.standings?.length)
            : new Date(data.event.startDate).getTime() <= Date.now();
          if (!eventStarted) return null;
          if (!showWins && !showLosses && !showGoalDiff) return null;
          return (
            <section className="stats">
              {showWins && (
                <button
                  type="button"
                  className={`stat win press-feedback${statsAccordion === "wins" ? " active" : ""}`}
                  onClick={() => setStatsAccordion((s) => (s === "wins" ? null : "wins"))}
                  aria-expanded={statsAccordion === "wins"}
                  aria-label={`${record.wins} wins — tap to see game details`}
                >
                  <div className="label">Wins</div>
                  <div className="value">{record.wins}</div>
                </button>
              )}
              {showLosses && (
                <button
                  type="button"
                  className={`stat loss press-feedback${statsAccordion === "losses" ? " active" : ""}`}
                  onClick={() => setStatsAccordion((s) => (s === "losses" ? null : "losses"))}
                  aria-expanded={statsAccordion === "losses"}
                  aria-label={`${record.losses} losses — tap to see game details`}
                >
                  <div className="label">Losses</div>
                  <div className="value">{record.losses}</div>
                </button>
              )}
              {showGoalDiff && (
                <div className="stat pos" aria-label={`Goal differential: ${goalDiff > 0 ? "+" : ""}${goalDiff}`}>
                  <div className="label">Goal Diff</div>
                  <div className="value">{goalDiff > 0 ? "+" : ""}{goalDiff}</div>
                </div>
              )}
            </section>
          );
        })()}

        <StatsAccordion
          mode={statsAccordion}
          games={data?.games || []}
          tz={activeTz}
          record={record}
          onClose={() => setStatsAccordion(null)}
        />

        {(() => {
          const startMs = tournamentMeta?.startDate
            ? new Date(tournamentMeta.startDate).getTime()
            : null;
          const notStarted = startMs && startMs > Date.now() && !nextEvent && !eventOver;
          if (notStarted) {
            return (
              <UpcomingTournamentCountdown
                tournament={tournament}
                eventMeta={tournamentMeta}
                onTap={showCountdownInfo}
              />
            );
          }
          return (
            <NextHero
              event={nextEvent}
              minutesUntil={minutesUntil}
              projectedDone={data?.projectedDone}
              eventOver={eventOver}
              tz={activeTz}
            />
          );
        })()}

        <CalendarCard
          origin={origin}
          eventId={tournament.eventId}
          divId={tournament.divId}
          teamId={teamId}
          teamName={teamName}
          gameCount={upcomingGames.length}
        />

        <nav className="tabs">
          {[
            ["schedule",      "Schedule",      "🗓"],
            ["standings",     "Standings",     "🏆"],
            ["stats",         "Stats",         "📊"],
            ["notifications", "Notifications", "🔔"],
          ].map(([id, label, icon]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              aria-label={label}
            >
              <span className="icon">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {tab === "schedule" && (
          <>
            {niwpWeeks && showTeamFilter && (
              <div className="schedule-filter-row">
                <label htmlFor="schedule-team-select" className="schedule-filter-label">
                  Team
                </label>
                <select
                  id="schedule-team-select"
                  className="team-select"
                  value={effectiveTeamFilter}
                  onChange={(e) => setScheduleTeamFilter(e.target.value)}
                >
                  {NIWP_TEAM_FILTERS
                    .filter(({ key }) => key === "all" || availableSubteams.has(key))
                    .map(({ key, label }) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                </select>
              </div>
            )}
            {upcomingGames.length > 0 && (
              <>
                <div className="section-title">Upcoming ({upcomingGames.length})</div>
                <div className="list list-2col">
                  {upcomingGames.map((g) => (
                    <UpcomingGameCard
                      key={g.id}
                      game={g}
                      expanded={expandedIds.has(g.id)}
                      onToggle={() => toggleExpanded(g.id)}
                      venue={tournament.venue}
                      tz={activeTz}
                      teamWatchNowLink={data?.teamWatchNowLink}
                      opponentInfo={standingsById.get(g.opponent)}
                      onAddCal={addCalSingle}
                      onOpenOpponent={openH2H}
                      onCourtTap={showCourtInfo}
                    />
                  ))}
                </div>
              </>
            )}
            {pastGames.length > 0 && (
              <>
                <div className="section-title">Results ({pastGames.length})</div>
                <SeasonArc
                  pastGames={pastGames}
                  onDotTap={(gid) => {
                    setExpandedIds((s) => {
                      const next = new Set(s);
                      next.add(gid);
                      return next;
                    });
                    if (typeof document !== "undefined") {
                      const el = document.getElementById(`game-${gid}`);
                      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                  }}
                />
                <PastGamesSummary standings={data?.standings || []} record={record} />
                <div className="list list-2col">
                  {pastGames.map((g) => (
                    <PastGameCard
                      key={g.id}
                      game={g}
                      expanded={expandedIds.has(g.id)}
                      onToggle={() => toggleExpanded(g.id)}
                      venue={tournament.venue}
                      tz={activeTz}
                      teamName={teamName}
                      opponentInfo={standingsById.get(g.opponent)}
                      onShare={shareGame}
                      justWon={recentWinIds.has(g.id)}
                      onOpenOpponent={openH2H}
                      onCourtTap={showCourtInfo}
                      onResultBadgeTap={(mode) => {
                        setStatsAccordion(mode);
                        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    />
                  ))}
                </div>
              </>
            )}
            {pastGames.length === 0 && upcomingGames.length === 0 && (
              <div className="empty">
                No games found yet.
                <br />
                Check back when the tournament starts.
              </div>
            )}
            <BracketView brackets={data?.brackets || []} />
          </>
        )}

        {tab === "standings" && (
          <>
            <PoolGrid pool={data?.pool} onTeamTap={openOpponent} />
            {standings.length === 0 ? (
              <div className="empty">No standings available.</div>
            ) : (
              (() => {
                const us = standings.find((s) => s.isUs);
                const others = standings.filter((s) => !s.isUs);
                const renderRow = (row, pinned = false) => (
                  <tr
                    key={row.teamId}
                    className={`${pinned ? "us-pinned" : ""} clickable-row`}
                    onClick={() => openOpponent(row.teamName)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openOpponent(row.teamName);
                      }
                    }}
                  >
                    <td className="rank">{row.rank ?? ""}</td>
                    <td className="team">
                      {row.teamName}
                      {row.earnedBid && (
                        <span title={row.bidAlias ? `Earned bid: ${row.bidAlias}` : "Earned bid"} style={{ marginLeft: 4 }}>
                          🎫
                        </span>
                      )}
                    </td>
                    <td className="num">{row.matchesWon}</td>
                    <td className="num">{row.matchesLost}</td>
                    <td className="num">{Math.round((row.setPercent || 0) * 100)}</td>
                  </tr>
                );
                return (
                  <table className="standings-table">
                    <tbody>
                      {us && renderRow(us, true)}
                      {others.map((row) => renderRow(row, false))}
                    </tbody>
                  </table>
                );
              })()
            )}
          </>
        )}

        {tab === "stats" && (
          <LeaderboardTab
            players={leaderboardData}
            loading={leaderboardLoading}
            onPlayerTap={(p) => setPlayerSheet(p)}
          />
        )}

        {tab === "notifications" && (
          <>
            <NotificationsCard teamId={teamId} onShowA2HS={showA2HSInstructions} />
          </>
        )}
          </>
        )}

        <footer className="footer-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {data?.scrapedAt
              ? `Updated ${new Date(data.scrapedAt).toLocaleTimeString()}`
              : "Loading…"}
            {data?.cached && <span className="cached-pill">Cached</span>}
            {data?._pollSchedule && (
              <span className="cached-pill" style={{ opacity: 0.7 }} title={data._pollSchedule.desc}>
                poll:{data._pollSchedule.mode}
              </span>
            )}
            {error && (
              <span className="cached-pill" style={{ color: "var(--loss)" }}>
                {error}
              </span>
            )}
            {/* Timezone toggle — shows venue TZ abbreviation when in venue mode */}
            <button
              className="tz-pill press-feedback"
              onClick={() => setTzOverride((v) => v === "venue" ? "local" : "venue")}
              title={tzOverride === "venue"
                ? `Times in venue timezone (${activeTzLabel || venueTz}) — tap to switch to device time`
                : "Times in your device timezone — tap to switch to venue time"}
            >
              {tzOverride === "venue" ? `${activeTzLabel || "PT"} ⇄` : "Local ⇄"}
            </button>
          </div>
          {data?.projectedDone && upcomingGames.length > 0 && (
            <button
              type="button"
              className="press-feedback"
              onClick={showProjectedDoneToast}
              style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}
            >
              Done ~{formatTimeOfDayInTz(data.projectedDone, activeTz)}
              {activeTzLabel ? ` ${activeTzLabel}` : ""}
              {data?.projectedDoneSource === "scheduled" ? " (scheduled)" : " (est.)"}
            </button>
          )}
        </footer>

        <div className="watermark">
          © 2026 Soren's Dad ·{" "}
          <a href="mailto:lswingrover@gmail.com">lswingrover@gmail.com</a>
        </div>
        </div>
        </>
        )}
      </div>

      {playerSheet && (
        <PlayerSheet player={playerSheet} onClose={() => setPlayerSheet(null)} />
      )}

      {h2hHasOpened && (
        <H2HSheet
          opponentName={h2hSheet}
          games={h2hGames}
          loading={h2hGamesLoading && !allGamesCache}
          onClose={() => setH2hSheet(null)}
        />
      )}

      <OpponentSheet
        data={opponentSheet}
        onClose={() => setOpponentSheet(null)}
        onOpenHistory={openOpponentHistory}
      />
      <InfoSheet data={infoSheet} onClose={() => setInfoSheet(null)} />
      <Toast text={toast} onClose={() => setToast(null)} />

      {tourStep > 0 && (
        <Tour
          step={tourStep}
          onNext={nextTourStep}
          onPrev={prevTourStep}
          onSkip={() => setTourStep(0)}
          onSetupTab={(t) => setTab(t)}
          onConfetti={() => celebrate(themeId)}
        />
      )}

      <TeamPickerSheet
        teams={teamPickerOpen ? teamsList : null}
        currentTeamId={teamId}
        onPick={(id) => {
          setTeamId(String(id));
          setTeamPickerOpen(false);
        }}
        onClose={() => setTeamPickerOpen(false)}
      />

      {winToast && (
        <div
          role="status"
          style={{
            position: "fixed",
            top: 12,
            left: 0,
            right: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 100,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              padding: "10px 18px",
              borderRadius: 999,
              fontWeight: 900,
              fontFamily: '"Barlow Condensed", sans-serif',
              fontSize: 18,
              letterSpacing: "0.06em",
              boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
            }}
          >
            🏐 W vs {winToast.opponent}!
          </div>
        </div>
      )}
    </>
  );
}
