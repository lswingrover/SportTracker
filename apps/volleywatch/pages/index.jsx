import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Head from "next/head";

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

// Confirmed via AES /api/event/{key}/standings for TeamId 201772, plus the
// SportsEngine team iCal feed for tournaments not on AES (those carry
// static: true and render a "no live data" card instead of fetching).
// Order: most-recent first; Big Sky is the default selection because it's
// the next upcoming event.
const TOURNAMENTS = [
  {
    id: "big-sky-volleyfest-2026",
    label: "Big Sky VolleyFest",
    chipLabel: "Big Sky",
    eventId: "PTAwMDAwNDI5NjU90",
    divId: "205376",
    teamId: "201772",
    teamName: "208 U14 Red",
    venue: {
      name: "Billings Metra Park",
      address: "Billings, MT",
      tz: "America/Denver",
    },
    date: "May 2, 2026",
  },
  {
    id: "erva-regional-2026",
    label: "ERVA Regional Championship",
    chipLabel: "ERVA Regional",
    eventId: "PTAwMDAwNDI2MDU90",
    divId: "203854",
    teamId: "201772",
    teamName: "208 U14 Red",
    venue: {
      name: "The Podium & HUB Sports Center",
      address: "Spokane, WA",
      tz: "America/Los_Angeles",
    },
    date: "Apr 25, 2026",
  },
  {
    id: "mt-nw-jamboree-2026",
    label: "MT NW Jamboree U14",
    chipLabel: "MT NW",
    eventId: "PTAwMDAwNDQ5NzY90",
    divId: "213538",
    teamId: "201772",
    teamName: "208 U14 Red",
    venue: {
      name: "Glacier High School",
      address: "Kalispell, MT",
      tz: "America/Denver",
    },
    date: "Mar 28, 2026",
  },
  {
    id: "showtime-slammer-2026",
    label: "Showtime Slammer",
    chipLabel: "Showtime",
    static: true,
    teamName: "208 U14 Red",
    venue: {
      name: "Showtime Volleyball",
      address: "9044 W Prairie Ave, Post Falls, ID 83854",
      tz: "America/Los_Angeles",
    },
    date: "Mar 21, 2026",
  },
  {
    id: "erva-power-league-2026",
    label: "ERVA Power League (multi-week)",
    chipLabel: "Power League",
    eventId: "PTAwMDAwNDI2MDY90",
    divId: "203858",
    teamId: "201772",
    teamName: "208 U14 Red",
    venue: {
      name: "HUB Sports Center & Prairie Athletic Center, EWU",
      address: "Spokane & Post Falls",
      tz: "America/Los_Angeles",
    },
    date: "Jan 3 – Apr 18, 2026",
  },
  {
    id: "sandpoint-showdown-2026",
    label: "Sandpoint Showdown",
    chipLabel: "Sandpoint",
    static: true,
    teamName: "208 U14 Red",
    venue: {
      name: "Sandpoint",
      address: "410 S Division Ave, Sandpoint, ID 83864",
      tz: "America/Los_Angeles",
    },
    date: "Feb 15, 2026",
  },
  {
    id: "holly-jolly-jamboree-2025",
    label: "Holly Jolly Jamboree",
    chipLabel: "Holly Jolly",
    static: true,
    teamName: "208 U14 Red",
    venue: {
      name: "Holly Jolly Jamboree",
      address: null,
      tz: "America/Los_Angeles",
    },
    date: "Dec 6, 2025",
  },
];

// Pick the tournament whose date is closest to today, preferring ones that
// started ≤7 days ago (active/recent) over future events.
function getSmartDefaultTournamentId() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const withDates = TOURNAMENTS.map((t) => {
    // Multi-week ranges like "Jan 3 – Apr 18, 2026" → use the end date
    const raw = t.date || "";
    const clean = raw.includes("–") ? raw.split("–")[1].trim() : raw;
    const d = new Date(clean);
    return isNaN(d.getTime()) ? null : { id: t.id, ms: d.getTime() };
  }).filter(Boolean);

  if (!withDates.length) return TOURNAMENTS[0].id;

  // Prefer tournaments that started ≤7 days ago (pick most recent of those)
  const sevenDaysAgo = todayMs - 7 * 24 * 60 * 60 * 1000;
  const recent = withDates.filter((t) => t.ms >= sevenDaysAgo && t.ms <= todayMs);
  if (recent.length > 0) {
    return recent.sort((a, b) => b.ms - a.ms)[0].id;
  }

  // Otherwise pick the tournament closest to today (past or future)
  return withDates.reduce((a, b) =>
    Math.abs(a.ms - todayMs) < Math.abs(b.ms - todayMs) ? a : b
  ).id;
}

const THEMES = [
  { id: "default", label: "Sport (orange)" },
  { id: "208", label: "208 (royal blue/black)" },
];

const REFRESH_MS = 2 * 60 * 1000;
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
    "PRODID:-//208 Tracker//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${g.id}@208tracker`,
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
  // 208 girls volleyball — royal blue + hot pink + white. Default theme keeps
  // the orange/green/white burst.
  const colors =
    themeId === "208"
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
      <div className="matchup">208 vs {live.opponent}</div>
      <div className="scoreline">
        <span style={{ color: "var(--text)" }}>{live.us}</span>
        <span className="vs">–</span>
        <span style={{ color: live.them > live.us ? "var(--loss)" : "var(--text)" }}>
          {live.them}
        </span>
        <span className="vs" style={{ fontSize: 18 }}>
          Set {live.setNumber}
        </span>
      </div>
      {sets.length > 0 && (
        <div className="stacked-sets">
          {sets.map((s, i) => {
            const inProgress = i === sets.length - 1 && !s.complete;
            const cls = ["set-row", s.deciding ? "deciding" : "", inProgress ? "in-progress" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div className={cls} key={i}>
                <span className="label">
                  Set {i + 1}
                  {s.deciding ? " · Deciding" : ""}
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
          ⏸ May be between sets — score hasn't moved in {Math.round(idleMs / 60000)} min
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
  { id: "schedule-change", label: "Schedule / court changes" },
  { id: "bracket-advance", label: "Bracket advancement" },
  { id: "work-soon", label: "Work duty", timing: true, defaultLead: 30 },
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
  const url = `${origin}/api/calendar.ics?eventId=${eventId}&divId=${divId}&teamId=${teamId}&teamName=${encodeURIComponent(teamName)}`;
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

function StaticTournamentCard({ tournament }) {
  const { venue, date, label } = tournament;
  const mapsHref =
    venue?.address &&
    `https://maps.apple.com/?q=${encodeURIComponent(`${venue.name || ""} ${venue.address}`.trim())}`;
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
      <div className="static-note">
        No live data available for this tournament — it isn't published on the
        AES system. Check the team's SportsEngine page for schedule details.
      </div>
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

function WorkUrgencyBanner({ workAssignments }) {
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  if (now == null) return null;
  const next = (workAssignments || [])
    .filter((w) => w.timeISO)
    .map((w) => ({ ...w, ms: new Date(w.timeISO).getTime() }))
    .filter((w) => w.ms > now && w.ms - now < 60 * 60 * 1000)
    .sort((a, b) => a.ms - b.ms)[0];
  if (!next) return null;
  const minsAway = Math.max(1, Math.round((next.ms - now) / 60000));
  return (
    <div className="work-urgent" role="status">
      <span className="icon">🟡</span>
      <div style={{ minWidth: 0 }}>
        <div className="role">⚠️ Work duty in {minsAway} min — {next.role}</div>
        <div className="meta">Court {next.court}{next.teams ? ` · ${next.teams}` : ""}</div>
      </div>
    </div>
  );
}

function PastGamesSummary({ standings, record }) {
  const us = standings.find((s) => s.isUs);
  return (
    <div className="record-summary">
      <span className="record-final">Final: {record.wins}–{record.losses}</span>
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
  ctx.fillText(teamName || "208 U14 Red", 20, 18);

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
  ctx.fillText("volleywatch-app.vercel.app", W - 18, H - 16);
  ctx.textAlign = "left";

  // Convert to blob → File and share / download
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const filename = `208-${(game.opponent || "result").replace(/\s+/g, "_")}.png`;
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
  // Watch precedence: AES-provided videoLink > Hudl broadcast for this opponent
  // > generic teamWatchNowLink while LIVE.
  const watchUrl = game.videoLink || game.watchUrl || (game.live ? teamWatchNowLink : null);
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
              className="opp-tap"
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
          <div className="score-hero">{setsCount || game.score || (game.result === "W" ? "Won" : game.result === "L" ? "Lost" : game.done ? "Pending" : "—")}</div>
          <div className="score-meta">
            vs{" "}
            <span
              className="opp-tap"
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
          {game.watchUrl && (
            <a
              className="watch-chip"
              href={game.watchUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Watch ${game.opponent} on Hudl Fan`}
              title="Watch on Hudl Fan"
            >
              ▶ Watch
            </a>
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
                  <th>Set</th>
                  <th>208</th>
                  <th>Opp</th>
                </tr>
              </thead>
              <tbody>
                {game.sets.map((s, i) => {
                  const usWin = s.us > s.them;
                  return (
                    <tr key={i} className={s.deciding ? "deciding" : ""}>
                      <td>
                        {i + 1}
                        {s.deciding ? <span className="deciding-mark">●</span> : null}
                      </td>
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
  { title: "Live score banner", body: "When a game is live, this banner appears with real-time scores pulled from AES every 30 seconds." },
  { sideEffect: "confetti", title: "🎉 Wins!", body: "Win a game and the app celebrates with confetti." },
  { selector: ".card.past", setupTab: "schedule", title: "Past games", body: "Tap any past game to expand. See set-by-set scores and share the result as an image." },
  { selector: ".tabs button:nth-child(2)", setupTab: "standings", title: "Standings", body: "Tap any team row to see their record and your head-to-head history. The 208 row pinned at the top opens a season summary." },
  { selector: ".tabs button:nth-child(3)", setupTab: "work", title: "Work duties", body: "Your team's court assignments. A sticky alert appears when a duty is within 2 hours." },
  { selector: ".notif-card", setupTab: "schedule", title: "Notifications", body: "Subscribe to push alerts. Each alert type has its own timing — set how early you want the heads-up." },
  { selector: ".calendar-section", title: "Calendar", body: "Subscribe to the team calendar so every tournament auto-appears in your phone's calendar app." },
  { title: "Add to Home Screen", body: "Add this app to your home screen for a native app experience — Safari → Share → Add to Home Screen. No App Store required." },
  { sideEffect: "confetti", title: "You're all set. Go get 'em! 🏐", body: "" },
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
        <div className="pool-grid-title">{pool.poolName} — 208's pool</div>
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
        Round-robin match results not available from AES
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
  const [open, setOpen] = useState(true);
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
            ? `${missing} ${mode === "wins" ? "win" : "loss"}${missing === 1 ? "" : "es"} in pool play — match details not available from AES.`
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
          {missing === 1 ? "" : mode === "wins" ? "s" : "es"} — match details not available from AES
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
          <div className="sub">208 vs {opponentName} · season history</div>
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
              <div className="label">Sets</div>
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

// Sticky alert when the next work duty is within 2 hours. Floats above
// the bottom nav, dismissable for the rest of the session.
function DutySticky({ workAssignments, dismissed, onDismiss, tz }) {
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  if (now == null || dismissed) return null;
  const next = (workAssignments || [])
    .filter((w) => w.timeISO)
    .map((w) => ({ ...w, ms: new Date(w.timeISO).getTime() }))
    .filter((w) => w.ms > now && w.ms - now < 2 * 60 * 60 * 1000)
    .sort((a, b) => a.ms - b.ms)[0];
  if (!next) return null;
  const tzLabel = tzShortLabel(tz);
  const t = `${formatInTz(next.timeISO, tz, { hour: "numeric", minute: "2-digit" })}${tzLabel ? ` ${tzLabel}` : ""}`;
  return (
    <div className="duty-sticky" role="status">
      <span className="icon">⚠️</span>
      <div className="text">
        Work duty at {t} — {next.role} · Court {next.court}
      </div>
      <button className="dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

export default function Home() {
  // Tournament selection: uses smart default on fresh/stale visits, restores
  // the previous selection only if the user was here within the last 48 hours.
  const [tournamentId, setTournamentId] = usePersistentState(
    "tournamentId",
    getSmartDefaultTournamentId()
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = JSON.parse(localStorage.getItem("vw_last_tournament") || "null");
      const now = Date.now();
      const fortyEightHours = 48 * 60 * 60 * 1000;
      if (stored && stored.id && stored.timestamp && (now - stored.timestamp) < fortyEightHours) {
        // Recent visit — restore their tournament selection if still valid
        const valid = TOURNAMENTS.find((t) => t.id === stored.id);
        setTournamentId(valid ? stored.id : getSmartDefaultTournamentId());
      } else {
        // First visit or >48 h since last visit — pick smart default
        setTournamentId(getSmartDefaultTournamentId());
      }
    } catch {}
    // intentionally only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist tournament selection with timestamp so the 48h restore works
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("vw_last_tournament", JSON.stringify({ id: tournamentId, timestamp: Date.now() }));
    } catch {}
  }, [tournamentId]);

  const [themeId, setThemeId] = usePersistentState("themeId", "208");
  const tournament = TOURNAMENTS.find((t) => t.id === tournamentId) || TOURNAMENTS[0];
  const [teamId, setTeamId] = usePersistentState(
    `teamId-${tournament.id}`,
    tournament.teamId
  );

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("schedule");
  const [changedIds, setChangedIds] = useState(new Set());
  const [recentWinIds, setRecentWinIds] = useState(new Set());
  const [winToast, setWinToast] = useState(null);
  const [lastLiveChange, setLastLiveChange] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [dutyDismissed, setDutyDismissed] = useState(false);
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
      title: "208 U14 Red Tracker",
      text: "Live scores & schedule for 208 U14 Red volleyball",
      url: typeof window !== "undefined" ? window.location.origin : "https://volleywatch-app.vercel.app",
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
  const [statsAccordion, setStatsAccordion] = useState(null); // 'wins' | 'losses' | null
  const [toast, setToast] = useState(null);
  const [infoSheet, setInfoSheet] = useState(null);
  const [tourStep, setTourStep] = useState(0);
  const [tourSeen, setTourSeen] = usePersistentState("tourSeen", false);
  const [tourNudgeDismissed, setTourNudgeDismissed] = usePersistentState("tourNudgeDismissed", false);
  // Hudl live banner: dismissed per tournament-id so it returns when the
  // user switches chips or comes back tomorrow. Stored as { [tournamentId]: ms }.
  const [hudlBannerDismissed, setHudlBannerDismissed] = usePersistentState("hudlBannerDismissed", {});
  const [opponentHistory, setOpponentHistory] = useState(null); // opponent name | null
  const [historyData, setHistoryData] = useState({}); // tournamentId -> payload
  const [historyLoading, setHistoryLoading] = useState(false);
  const [userRefreshing, setUserRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);

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
          const url = `/api/tournament?eventId=${encodeURIComponent(t.eventId)}&divId=${encodeURIComponent(t.divId)}&teamId=${encodeURIComponent(t.teamId)}&teamName=${encodeURIComponent(t.teamName)}${t.venue?.tz ? `&tz=${encodeURIComponent(t.venue.tz)}` : ""}`;
          const res = await fetch(url);
          if (!res.ok) return;
          const json = await res.json();
          setHistoryData((prev) => ({ ...prev, [t.id]: json }));
        } catch {}
      })
    );
    setHistoryLoading(false);
  }

  // ── hash routing ───────────────────────────────────────────────────────────
  // On mount, restore #tournament=<id> directly, and #opponent=<slug> by
  // loading every tournament until we find a match.
  const [hashHydrated, setHashHydrated] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = readHashParams();
    let cancelled = false;
    if (hash.tournament) {
      const t = TOURNAMENTS.find((x) => x.id === hash.tournament);
      if (t) setTournamentId(t.id);
    }
    if (hash.opponent) {
      (async () => {
        // Pull every dynamic tournament so we can scan opponents.
        const fetched = {};
        await Promise.all(
          TOURNAMENTS.filter((t) => !t.static).map(async (t) => {
            try {
              const url = `/api/tournament?eventId=${encodeURIComponent(t.eventId)}&divId=${encodeURIComponent(t.divId)}&teamId=${encodeURIComponent(t.teamId)}&teamName=${encodeURIComponent(t.teamName)}`;
              const res = await fetch(url);
              if (!res.ok) return;
              fetched[t.id] = await res.json();
            } catch {}
          })
        );
        if (cancelled) return;
        let matchName = null;
        for (const tid of Object.keys(fetched)) {
          for (const g of fetched[tid]?.games || []) {
            if (slugifyHashValue(g.opponent) === hash.opponent) {
              matchName = g.opponent;
              break;
            }
          }
          if (matchName) break;
        }
        if (matchName) {
          setHistoryData(fetched);
          setOpponentHistory(matchName);
        }
      })();
    }
    setHashHydrated(true);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync state → hash. Only writes after hash has been read on mount so we
  // don't clobber the user's deep link before restore completes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hashHydrated) return;
    const parts = [];
    if (tournamentId) parts.push(`tournament=${encodeURIComponent(tournamentId)}`);
    if (opponentHistory) parts.push(`opponent=${encodeURIComponent(slugifyHashValue(opponentHistory))}`);
    const newHash = parts.length ? `#${parts.join("&")}` : "";
    if (newHash !== window.location.hash) {
      const url = window.location.pathname + window.location.search + newHash;
      window.history.replaceState(null, "", url || window.location.pathname);
    }
  }, [hashHydrated, tournamentId, opponentHistory]);

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

  function showWorkDutyInfo(w) {
    if (!w) return;
    const tz = tournament.venue?.tz;
    const tzLabel = tzShortLabel(tz);
    const reportTime = w.timeISO
      ? `${formatInTz(w.timeISO, tz, { weekday: "short", hour: "numeric", minute: "2-digit" })}${tzLabel ? ` ${tzLabel}` : ""}`
      : "TBD";
    setInfoSheet({
      title: w.role,
      subtitle: `Court ${w.court}${w.teams ? ` · ${w.teams}` : ""}`,
      lines: [
        { text: `Your team is assigned to ${w.role.toLowerCase()} duty.` },
        { text: `Report by ${reportTime}.`, muted: true },
      ],
      closeLabel: "Got it",
    });
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

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
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
      if (tournament.static) {
        // Static tournaments aren't on AES — no data to fetch. Reset state so
        // switching from a live tournament doesn't leak its games/standings.
        prevDataRef.current = null;
        prevLiveRef.current = null;
        firstLoadRef.current = true;
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        const url = `/api/tournament?eventId=${encodeURIComponent(tournament.eventId)}&divId=${encodeURIComponent(tournament.divId)}&teamId=${encodeURIComponent(teamId)}&teamName=${encodeURIComponent(teamName)}${tournament.venue?.tz ? `&tz=${encodeURIComponent(tournament.venue.tz)}` : ""}${force ? "&force=1" : ""}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const next = await res.json();

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
        setError(String(e.message || e));
      } finally {
        setLoading(false);
        if (force) { setUserRefreshing(false); setRefreshDone(true); setTimeout(() => setRefreshDone(false), 2000); }
      }
    },
    [tournament.eventId, tournament.divId, teamId, teamName, themeId]
  );

  useEffect(() => {
    firstLoadRef.current = true;
    prevDataRef.current = null;
    load();
  }, [load]);

  useInterval(() => load(), REFRESH_MS);

  const games = data?.games || [];
  const pastGames = games.filter((g) => g.done);
  const upcomingGames = games.filter((g) => !g.done);
  const standings = data?.standings || [];
  const standingsById = useMemo(() => {
    const m = new Map();
    for (const s of standings) m.set(s.teamName, s);
    return m;
  }, [standings]);
  const work = data?.workAssignments || [];
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
    const full = `${text} #208volleyball #volleyball`;
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({ title: "VolleyWatch", text: full }).catch(() => {});
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(full).then(() => alert("Copied")).catch(() => {});
    }
  }

  function addCalSingle(g) {
    const ics = buildSingleICS(g, teamName);
    if (!ics) return;
    const slug = (g.opponent || "game").replace(/\s+/g, "_");
    downloadICS(`208-${slug}.ics`, ics);
  }

  async function shareSummary() {
    const lines = [];
    lines.push(`${teamName} — ${record.wins}W ${record.losses}L`);
    if (data?.poolPosition) lines.push(`Pool: ${data.poolPosition}`);
    if (data?.liveGame) {
      lines.push(`LIVE: ${data.liveGame.us}-${data.liveGame.them} (Set ${data.liveGame.setNumber})`);
    } else if (nextEvent) {
      const what = nextEvent.kind === "work" ? nextEvent.role : `vs ${nextEvent.opponent}`;
      lines.push(`Next: ${nextEvent.time} · Court ${nextEvent.court} · ${what}`);
    }
    const text = lines.join("\n");
    try {
      if (navigator.share) await navigator.share({ title: "VolleyWatch", text });
      else {
        await navigator.clipboard.writeText(text);
        alert("Copied to clipboard");
      }
    } catch {}
  }

  return (
    <>
      <Head>
        <title>VolleyWatch</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      </Head>
      <div className="app">
        {opponentHistory ? (
          <OpponentHistoryPage
            opponentName={opponentHistory}
            tournaments={TOURNAMENTS}
            dataByTournament={historyData}
            loading={historyLoading}
            tz={tournament.venue?.tz}
            onBack={() => setOpponentHistory(null)}
          />
        ) : (
        <>
        <header className="header-compact">
          <div className="team-name" title="VolleyWatch">🏐 VolleyWatch</div>
          {data?.liveGame && (
            <span className="live-pill" aria-label="Live game">
              <span className="live-dot" /> LIVE
            </span>
          )}
          <div className="header-compact-actions">
            <button
              className={`icon-only-btn${userRefreshing ? " spinning" : ""}${refreshDone ? " done" : ""}`}
              onClick={() => { if (!userRefreshing) load(true); }}
              aria-label="Refresh"
              title="Refresh data"
              disabled={userRefreshing || !tournament.eventId}
            >
              {refreshDone ? "✓" : "↺"}
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

        {data?.teamWatchNowLink && !hudlBannerDismissed[tournamentId] && (
          <div className="hudl-live-banner" role="status">
            <a
              className="hudl-live-link"
              href={data.teamWatchNowLink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Watch live on Hudl"
            >
              <span className="hudl-live-dot" aria-hidden="true">●</span>
              <span className="hudl-live-text">LIVE on Hudl</span>
              <span className="hudl-live-arrow" aria-hidden="true">→</span>
            </a>
            <button
              type="button"
              className="hudl-live-dismiss"
              aria-label="Dismiss Hudl live banner"
              onClick={() =>
                setHudlBannerDismissed({ ...hudlBannerDismissed, [tournamentId]: Date.now() })
              }
            >
              ×
            </button>
          </div>
        )}

        <div className="chip-row" role="tablist" aria-label="Tournaments">
          {TOURNAMENTS.map((t) => (
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
          ))}
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

        {tournament.static ? (
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
          // wins / losses, hide pool when no rank is known.
          const showWins = record.wins > 0;
          const showLosses = record.losses > 0;
          const rankLabel = data?.poolPosition;
          const showRank = Boolean(rankLabel);
          const eventStarted = !data?.event?.startDate
            ? Boolean(data?.games?.length || data?.standings?.length)
            : new Date(data.event.startDate).getTime() <= Date.now();
          if (!eventStarted) return null;
          if (!showWins && !showLosses && !showRank) return null;
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
              {showRank && (
                <button
                  type="button"
                  className="stat pos press-feedback"
                  onClick={() => {
                    setTab("standings");
                    setTimeout(() => {
                      if (typeof document !== "undefined") {
                        document
                          .querySelector(".standings-table tr.us-pinned")
                          ?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }
                    }, 100);
                  }}
                  aria-label={`Pool rank ${rankLabel} — view standings`}
                >
                  <div className="label">{eventOver ? "Rank" : "Pool"}</div>
                  <div className="value">{rankLabel}</div>
                </button>
              )}
            </section>
          );
        })()}

        <StatsAccordion
          mode={statsAccordion}
          games={data?.games || []}
          tz={tournament.venue?.tz}
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
              tz={tournament.venue?.tz}
            />
          );
        })()}

        <NotificationsCard teamId={teamId} onShowA2HS={showA2HSInstructions} />

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
            ["schedule", "Schedule", "🗓"],
            ["standings", "Standings", "🏆"],
            ["work", "Duties", "🟡"],
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
                      tz={tournament.venue?.tz}
                      teamWatchNowLink={data?.teamWatchNowLink}
                      opponentInfo={standingsById.get(g.opponent)}
                      onAddCal={addCalSingle}
                      onOpenOpponent={openOpponent}
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
                      tz={tournament.venue?.tz}
                      teamName={teamName}
                      opponentInfo={standingsById.get(g.opponent)}
                      onShare={shareGame}
                      justWon={recentWinIds.has(g.id)}
                      onOpenOpponent={openOpponent}
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
                No games returned by AES yet for this team.
                <br />
                Check back when the tournament starts.
              </div>
            )}
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

        {tab === "work" && (
          <>
            {work.length === 0 ? (
              <div className="empty">No work duties scheduled.</div>
            ) : (
              <div className="list">
                {work.map((w) => {
                  const tz = tournament.venue?.tz;
                  const tzLabel = tzShortLabel(tz);
                  const wTime = w.timeISO
                    ? `${formatInTz(w.timeISO, tz)}${tzLabel ? ` ${tzLabel}` : ""}`
                    : w.time || "TBD";
                  return (
                    <article
                      key={w.id}
                      className="card press-feedback"
                      role="button"
                      tabIndex={0}
                      onClick={() => showWorkDutyInfo(w)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          showWorkDutyInfo(w);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="card-row">
                        <div>
                          <div className="opp">{w.role}</div>
                          <div className="meta">
                            {wTime} · Court {w.court}
                          </div>
                          {w.teams && <div className="meta">{w.teams}</div>}
                        </div>
                        <span className="badge">Work</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
          </>
        )}

        <BracketView brackets={data?.brackets || []} />

        <footer className="footer-bar">
          <div>
            {data?.scrapedAt
              ? `Updated ${new Date(data.scrapedAt).toLocaleTimeString()}`
              : "Loading…"}
            {data?.cached && <span className="cached-pill">Cached</span>}
            {error && (
              <span className="cached-pill" style={{ color: "var(--loss)" }}>
                {error}
              </span>
            )}
          </div>
          {data?.projectedDone && upcomingGames.length > 0 && (
            <button
              type="button"
              className="press-feedback"
              onClick={showProjectedDoneToast}
              style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}
            >
              Done ~{formatTimeOfDayInTz(data.projectedDone, tournament.venue?.tz)}
              {tzShortLabel(tournament.venue?.tz) ? ` ${tzShortLabel(tournament.venue?.tz)}` : ""}
              {data?.projectedDoneSource === "scheduled" ? " (scheduled)" : " (est.)"}
            </button>
          )}
        </footer>

        <div className="watermark">
          © 2026 Bella's Dad ·{" "}
          <a href="mailto:lswingrover@gmail.com">lswingrover@gmail.com</a>
        </div>
        </div>
        </>
        )}
      </div>

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

      {!tournament.static && (tab === "schedule" || tab === "work") && (
        <DutySticky
          workAssignments={work}
          dismissed={dutyDismissed}
          onDismiss={() => setDutyDismissed(true)}
          tz={tournament.venue?.tz}
        />
      )}

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
