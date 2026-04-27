import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Head from "next/head";

const TOURNAMENTS = [
  {
    id: "liberty-lake-2026",
    label: "Liberty Lake Crossover",
    eventId: "PTAwMDAwNDI2MDU90",
    divId: "203854",
    teamId: "201772",
    teamName: "208 U14 Red",
    venue: {
      name: "Liberty Lake Sports Complex",
      address: "1421 N Pepper Ln, Liberty Lake, WA 99019",
      tz: "America/Los_Angeles",
    },
    date: "2026-04",
  },
];

const THEMES = [
  { id: "default", label: "Sport (orange)" },
  { id: "208", label: "208 (navy/gold)" },
];

const REFRESH_MS = 2 * 60 * 1000;
const CONFETTI_SRC = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";

function pad(n) {
  return String(n).padStart(2, "0");
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  if (!targetISO) return null;
  const diff = new Date(targetISO).getTime() - now;
  return Math.round(diff / 60000);
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
  const colors =
    themeId === "208" ? ["#B8960C", "#002147", "#ffffff"] : ["#f97316", "#ffffff", "#22c55e"];
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
      {sets.length > 1 && (
        <div className="meta" style={{ marginTop: 8 }}>
          {sets.map((s, i) => {
            const live = i === live?.setIndex && !s.complete;
            return (
              <span key={i} style={{ marginRight: 10 }}>
                Set {i + 1}: {s.us}-{s.them} {s.complete ? "✓" : i === sets.length - 1 ? "🔴" : ""}
              </span>
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

function NextHero({ event, minutesUntil, projectedDone, eventOver }) {
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
            ? `Projected end: ${new Date(projectedDone).toLocaleString()}`
            : "Schedule data not yet available."}
        </div>
      </section>
    );
  }
  const work = event.kind === "work";
  return (
    <section className={`hero${work ? " work" : ""}`}>
      <h2>
        {work ? "🟡 Next work duty" : "▶ Next match"}
      </h2>
      <div className="opp">
        {work ? event.role : `vs ${event.opponent}`}
      </div>
      <div className="meta">
        {event.time} · Court {event.court}
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
    </section>
  );
}

function NotificationsCard({ upcoming }) {
  const [perm, setPerm] = useState(
    typeof window === "undefined" ? "default" : Notification?.permission || "unsupported"
  );
  const timersRef = useRef([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) {
      setPerm("unsupported");
      return;
    }
    setPerm(Notification.permission);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (perm !== "granted") return;
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    const now = Date.now();
    for (const g of upcoming) {
      if (!g.timeISO) continue;
      const ms = new Date(g.timeISO).getTime();
      for (const lead of [30, 10]) {
        const fireAt = ms - lead * 60 * 1000;
        const delay = fireAt - now;
        if (delay <= 0) continue;
        const id = setTimeout(() => {
          try {
            new Notification(`208 vs ${g.opponent} in ${lead} min`, {
              body: `Court ${g.court} · ${g.time}`,
              tag: `${g.id}-${lead}`,
              icon: "/icon-192.svg",
            });
          } catch {}
        }, delay);
        timersRef.current.push(id);
      }
    }
    return () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, [upcoming, perm]);

  async function ask() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setPerm(result);
  }

  if (perm === "unsupported") return null;
  const on = perm === "granted";
  const blocked = perm === "denied";

  return (
    <div className={`notif-card${on ? " on" : ""}`}>
      <div style={{ minWidth: 0 }}>
        <div className="title">
          <span>🔔</span>
          <span>Game alerts</span>
          <span className={`state${on ? " on" : blocked ? " blocked" : ""}`}>
            {on ? "On" : blocked ? "Blocked" : "Off"}
          </span>
        </div>
        <div className="desc">
          {blocked
            ? "Enable in browser settings to receive alerts."
            : "Get notified 30 min and 10 min before each game while this tab is open."}
        </div>
      </div>
      {!on && !blocked && (
        <button className="btn-primary" onClick={ask}>
          Enable
        </button>
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
          Add to iPhone
        </a>
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn-mini" onClick={copy}>
          Copy URL
        </button>
        <a className="btn-mini" href={url} target="_blank" rel="noreferrer">
          Open feed
        </a>
      </div>
    </div>
  );
}

function GameCard({ game, opponentInfo, teamName, onShare, onAddCal, justWon, teamWatchNowLink }) {
  const watchUrl = game.videoLink || (game.live ? teamWatchNowLink : null);
  const cls = [
    "card",
    game.next ? "next" : "",
    game.result === "W" ? "win" : "",
    game.result === "L" ? "loss" : "",
    game.done ? "past" : "",
    game.live ? "live-card" : "",
    justWon ? "just-won" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cls}>
      <div className="card-row">
        <div style={{ minWidth: 0 }}>
          <div className="opp">vs {game.opponent}</div>
          <div className="meta">
            {game.time || "TBD"} · Court {game.court}
          </div>
          {opponentInfo && (
            <div className="meta">
              Opp record {opponentInfo.matchesWon}-{opponentInfo.matchesLost}
              {opponentInfo.rank ? ` · #${opponentInfo.rank} in pool` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {game.live && <span className="badge live">Live</span>}
          {game.result === "W" && <span className="badge win">Won</span>}
          {game.result === "L" && <span className="badge loss">Lost</span>}
          {!game.done && game.next && !game.live && <span className="badge next">Next</span>}
          {!game.done && !game.next && !game.live && <span className="badge">Upcoming</span>}
        </div>
      </div>
      {game.score && <div className="sets">Sets: {game.score}</div>}
      <div className="card-actions">
        {!game.done && game.timeISO && (
          <button className="btn-mini" onClick={() => onAddCal(game)}>
            📅 Add to calendar
          </button>
        )}
        {watchUrl && (
          <a className="btn-mini primary" href={watchUrl} target="_blank" rel="noreferrer">
            📺 Watch live
          </a>
        )}
        {game.done && game.result && (
          <button className="btn-mini" onClick={() => onShare(game)}>
            📣 Share result
          </button>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const [tournamentId, setTournamentId] = usePersistentState("tournamentId", TOURNAMENTS[0].id);
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
  const prevDataRef = useRef(null);
  const prevLiveRef = useRef(null);
  const firstLoadRef = useRef(true);
  const [origin, setOrigin] = useState("");

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
      try {
        setLoading(true);
        const url = `/api/tournament?eventId=${encodeURIComponent(tournament.eventId)}&divId=${encodeURIComponent(tournament.divId)}&teamId=${encodeURIComponent(teamId)}&teamName=${encodeURIComponent(teamName)}${force ? "&force=1" : ""}`;
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
      navigator.share({ title: "208 Tracker", text: full }).catch(() => {});
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
      lines.push(`Next: ${nextEvent.time} · Ct ${nextEvent.court} · ${what}`);
    }
    const text = lines.join("\n");
    try {
      if (navigator.share) await navigator.share({ title: "208 Tracker", text });
      else {
        await navigator.clipboard.writeText(text);
        alert("Copied to clipboard");
      }
    } catch {}
  }

  return (
    <>
      <Head>
        <title>208 Tournament Tracker</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      </Head>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <div className="logo">🏐</div>
            <div style={{ minWidth: 0 }}>
              <div className="name">{teamName}</div>
              <div className="sub">
                {tournamentName}
                {tournamentLocation ? ` · ${tournamentLocation}` : ""}
                {tournamentDateRange ? ` · ${tournamentDateRange}` : ""}
                {eventOver ? " · 🏁 Final" : ""}
                {data?.cached ? " · cached" : ""}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="iconbtn" onClick={shareSummary}>
              Share
            </button>
            <button className="iconbtn" onClick={() => load(true)} disabled={loading}>
              {loading ? "…" : "Refresh"}
            </button>
          </div>
        </header>

        <div className="selectors">
          <div className="selector">
            <label>Tournament</label>
            <select
              value={tournamentId}
              onChange={(e) => {
                setTournamentId(e.target.value);
                const next = TOURNAMENTS.find((t) => t.id === e.target.value);
                if (next) setTeamId(next.teamId);
              }}
            >
              {TOURNAMENTS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} · {t.date}
                </option>
              ))}
            </select>
          </div>
          <div className="selector">
            <label>Theme</label>
            <select value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="selector full">
            <label>Team</label>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teamsList.length === 0 && (
                <option value={teamId}>{teamName}</option>
              )}
              {teamsList.map((t) => (
                <option key={t.teamId} value={t.teamId}>
                  {t.teamName}
                  {t.club ? ` · ${t.club}` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        {data?.liveGame && (
          <LiveScoreBanner
            live={data.liveGame}
            lastChangedAt={lastLiveChange}
            watchUrl={data.liveGame?.videoLink || data.teamWatchNowLink || null}
          />
        )}

        <section className="stats">
          <div className="stat win">
            <div className="label">Wins</div>
            <div className="value">{record.wins}</div>
          </div>
          <div className="stat loss">
            <div className="label">Losses</div>
            <div className="value">{record.losses}</div>
          </div>
          <div className="stat pos">
            <div className="label">Pool</div>
            <div className="value">{data?.poolPosition || "—"}</div>
          </div>
        </section>

        <NextHero
          event={nextEvent}
          minutesUntil={minutesUntil}
          projectedDone={data?.projectedDone}
          eventOver={eventOver}
        />

        <NotificationsCard upcoming={upcomingGames} />

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
            ["schedule", "Schedule"],
            ["standings", "Standings"],
            ["work", "Work"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "schedule" && (
          <>
            {pastGames.length > 0 && (
              <>
                <div className="section-title">Past games · {pastGames.length}</div>
                <div className="list">
                  {pastGames.map((g) => (
                    <GameCard
                      key={g.id}
                      game={g}
                      teamName={teamName}
                      teamWatchNowLink={data?.teamWatchNowLink}
                      opponentInfo={standingsById.get(g.opponent)}
                      onShare={shareGame}
                      onAddCal={addCalSingle}
                      justWon={recentWinIds.has(g.id)}
                    />
                  ))}
                </div>
              </>
            )}
            {upcomingGames.length > 0 && (
              <>
                <div className="section-title">Upcoming · {upcomingGames.length}</div>
                <div className="list">
                  {upcomingGames.map((g) => (
                    <GameCard
                      key={g.id}
                      game={g}
                      teamName={teamName}
                      teamWatchNowLink={data?.teamWatchNowLink}
                      opponentInfo={standingsById.get(g.opponent)}
                      onShare={shareGame}
                      onAddCal={addCalSingle}
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
            {standings.length === 0 ? (
              <div className="empty">No standings available.</div>
            ) : (
              <table className="standings-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th>W-L</th>
                    <th>Set %</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((row) => (
                    <tr key={row.teamId} className={row.isUs ? "us" : ""}>
                      <td>{row.rank ?? ""}</td>
                      <td>{row.teamName}</td>
                      <td>
                        {row.matchesWon}-{row.matchesLost}
                      </td>
                      <td>{Math.round((row.setPercent || 0) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === "work" && (
          <>
            {work.length === 0 ? (
              <div className="empty">No work duties scheduled.</div>
            ) : (
              <div className="list">
                {work.map((w) => (
                  <article key={w.id} className="card">
                    <div className="card-row">
                      <div>
                        <div className="opp">{w.role}</div>
                        <div className="meta">
                          {w.time || "TBD"} · Court {w.court}
                        </div>
                        {w.teams && <div className="meta">{w.teams}</div>}
                      </div>
                      <span className="badge">Work</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

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
            <div>
              Done ~
              {new Date(data.projectedDone).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {data?.projectedDoneSource === "scheduled" ? " (scheduled)" : " (est.)"}
            </div>
          )}
        </footer>
      </div>

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
