// LeaderboardCluster.jsx — lazy-loaded chunk for stats/leaderboard UI.
// Extracted from pages/index.jsx to allow next/dynamic deferred loading.
// Only fetched on first user interaction (tab tap or H2H/player sheet open).
// GH#11.

import { useState, useMemo, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const LB_TEAM_FILTERS = [
  { key: "all",  label: "All" },
  { key: "B",    label: "18U Boys" },
  { key: "G",    label: "18U Girls" },
  { key: "BJV",  label: "JV Boys" },
  { key: "GJV",  label: "JV Girls" },
  { key: "D",    label: "Dev" },
];

const STAT_COLS = [
  { key: "goals",    short: "G",  title: "Goals" },
  { key: "assists",  short: "A",  title: "Assists" },
  { key: "steals",   short: "ST", title: "Steals" },
  { key: "blocks",   short: "BL", title: "Blocks" },
  { key: "kickouts", short: "KO", title: "Kickouts (Exclusions)" },
];

function lbPlayerPrefix(name) {
  if (!name) return null;
  const m = name.match(/^([A-Z]+)\s*-\s*/);
  return m ? m[1] : null;
}

function lbDisplayName(name) {
  return name ? name.replace(/^[A-Z]+\s*-\s*/, "") : name;
}

// ── LeaderboardTab ────────────────────────────────────────────────────────────

export function LeaderboardTab({ players, loading, onPlayerTap }) {
  const [teamFilter, setTeamFilter] = useState("B"); // default: 18U Boys
  const [sortKey, setSortKey]       = useState("goals");
  const [sortDir, setSortDir]       = useState("desc");

  function handleColClick(key) {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    if (!players) return [];
    let list = teamFilter === "all"
      ? players
      : players.filter((p) => lbPlayerPrefix(p.player_name) === teamFilter);
    return [...list].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [players, teamFilter, sortKey, sortDir]);

  if (loading) {
    return <div style={{ padding: "32px 16px", color: "var(--muted)", textAlign: "center" }}>Loading stats…</div>;
  }
  if (!players) return null;

  const cellR = { textAlign: "right", padding: "10px 6px", fontSize: 14 };
  const hdrR  = { textAlign: "right", padding: "8px 6px", fontSize: 11, fontWeight: 700,
                  letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
                  userSelect: "none" };

  return (
    <div style={{ paddingBottom: 16 }}>
      {/* Team filter chips */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "12px 16px 8px",
                    scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
        {LB_TEAM_FILTERS.map(({ key, label }) => {
          const active = teamFilter === key;
          return (
            <button
              key={key}
              onClick={() => setTeamFilter(key)}
              style={{
                flexShrink: 0,
                padding: "4px 12px",
                borderRadius: 999,
                border: active ? "2px solid var(--accent)" : "2px solid var(--line)",
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent-readable)" : "var(--muted)",
                fontSize: 13,
                fontWeight: 700,
                fontFamily: '"Barlow Condensed", Barlow, sans-serif',
                cursor: "pointer",
                letterSpacing: "0.04em",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Sortable table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--line)" }}>
              <th style={{ textAlign: "left", padding: "8px 16px", fontSize: 11, fontWeight: 700,
                           letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
                #
              </th>
              <th style={{ textAlign: "left", padding: "8px 4px", fontSize: 11, fontWeight: 700,
                           letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
                Player
              </th>
              <th style={{ ...hdrR, color: "var(--muted)" }}>GP</th>
              {STAT_COLS.map((col) => (
                <th
                  key={col.key}
                  title={col.title}
                  onClick={() => handleColClick(col.key)}
                  style={{
                    ...hdrR,
                    color: sortKey === col.key ? "var(--accent-readable)" : "var(--muted)",
                    minWidth: 34,
                  }}
                >
                  {col.short}
                  {sortKey === col.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => {
              return (
                <tr
                  key={p.player_id}
                  onClick={() => onPlayerTap(p)}
                  style={{
                    borderBottom: "1px solid var(--line)",
                    cursor: "pointer",
                  }}
                >
                  <td style={{ padding: "10px 16px", color: "var(--muted)", fontSize: 12 }}>{i + 1}</td>
                  <td style={{ padding: "10px 4px", minWidth: 120 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{lbDisplayName(p.player_name)}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>
                      {LB_TEAM_FILTERS.find((t) => t.key === lbPlayerPrefix(p.player_name))?.label
                        || lbPlayerPrefix(p.player_name)}{" "}
                      · Cap {p.cap_number}
                    </div>
                  </td>
                  <td style={{ ...cellR, color: "var(--muted)" }}>{p.games_played}</td>
                  {STAT_COLS.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        ...cellR,
                        fontWeight: sortKey === col.key ? 700 : 400,
                        color: sortKey === col.key ? "var(--text)" : "var(--muted)",
                      }}
                    >
                      {p[col.key] ?? 0}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div style={{ padding: "24px 16px", color: "var(--muted)", textAlign: "center" }}>
          No players in this group
        </div>
      )}

      <div style={{ padding: "12px 16px", color: "var(--muted)", fontSize: 12 }}>
        {filtered.length} player{filtered.length !== 1 ? "s" : ""}{" "}
        ·{" "}
        {teamFilter === "all"
          ? "All teams"
          : LB_TEAM_FILTERS.find((t) => t.key === teamFilter)?.label}
        {" "}· Tap any row for profile
      </div>
    </div>
  );
}

// ── PlayerSheet ───────────────────────────────────────────────────────────────

export function PlayerSheet({ player, onClose }) {
  if (!player) return null;
  const displayName = lbDisplayName(player.player_name);
  const prefix      = lbPlayerPrefix(player.player_name);
  const teamLabel   = LB_TEAM_FILTERS.find((t) => t.key === prefix)?.label || prefix;

  const statBlocks = [
    { label: "Goals",    value: player.goals,    avg: player.avg_goals_per_game?.toFixed(1) },
    { label: "Assists",  value: player.assists,   avg: player.avg_assists_per_game?.toFixed(1) },
    { label: "Steals",   value: player.steals,    avg: null },
    { label: "Blocks",   value: player.blocks,    avg: null },
    { label: "Kickouts", value: player.kickouts,  avg: null },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 60 }}
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-label={`${displayName} season stats`}
        style={{
          position: "fixed",
          bottom: 0, left: 0, right: 0,
          background: "var(--panel)",
          borderRadius: "18px 18px 0 0",
          zIndex: 61,
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          maxHeight: "85vh",
          overflowY: "auto",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.5)",
        }}
      >
        {/* Drag handle */}
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--line)", margin: "0 auto 18px" }} />

        {/* Player header */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 24, fontWeight: 900, fontFamily: '"Barlow Condensed", Barlow, sans-serif',
                        textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1.1 }}>
            {displayName}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 14, marginTop: 4 }}>
            {teamLabel} · Cap #{player.cap_number}
          </div>
        </div>

        {/* W/L record row */}
        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          {[
            { label: "Games",  value: player.games_played, color: null },
            { label: "Wins",   value: player.wins,         color: "var(--win)" },
            { label: "Loss",   value: player.losses,       color: "var(--loss)" },
            { label: "W%",     value: player.games_played > 0
                ? `${Math.round((player.win_pct ?? 0) * 100)}%` : "—", color: null },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              flex: 1, background: "var(--panel-2)", borderRadius: 10,
              padding: "10px 6px", textAlign: "center",
            }}>
              <div style={{ fontSize: 20, fontWeight: 900, color: color || "var(--text)" }}>
                {value ?? 0}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3,
                            textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* Stat blocks */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 20 }}>
          {statBlocks.map(({ label, value, avg }) => (
            <div key={label} style={{
              background: "var(--panel-2)", borderRadius: 10,
              padding: "12px 6px", textAlign: "center",
            }}>
              <div style={{ fontSize: 24, fontWeight: 900 }}>{value ?? 0}</div>
              <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase",
                            letterSpacing: "0.06em", marginTop: 2 }}>
                {label}
              </div>
              {avg != null && (
                <div style={{ fontSize: 11, color: "var(--accent-readable)", marginTop: 4 }}>
                  {avg}/g
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          style={{
            width: "100%", padding: 14, borderRadius: 12,
            border: "2px solid var(--line)", background: "transparent",
            color: "var(--text)", fontSize: 15, fontWeight: 700,
            fontFamily: '"Barlow Condensed", Barlow, sans-serif',
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}
        >
          Close
        </button>
      </div>
    </>
  );
}

// ── H2HSheet ──────────────────────────────────────────────────────────────────
// Bottom sheet showing full historical head-to-head record vs an opponent.
// Data comes from /api/historical?view=games (games.json — all 82 games).
// Convention from compute-aggregates.js: home_team is always CDA; away_team
// is the opponent. So home_score = Narwhals score, away_score = opp score.

export function H2HSheet({ opponentName, games, loading, onClose }) {
  useEffect(() => {
    if (!opponentName) return;
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opponentName, onClose]);

  const open = Boolean(opponentName);

  const wins        = (games || []).filter((g) => g._result === "W").length;
  const losses      = (games || []).filter((g) => g._result === "L").length;
  const ties        = (games || []).filter((g) => g._result === "T").length;
  const totalGoalDiff = (games || []).reduce((s, g) => s + g._goalDiff, 0);

  // Subteam breakdown — only rendered when >1 subteam present
  const bySubteam = useMemo(() => {
    const m = new Map();
    for (const g of (games || [])) {
      const k = g.team_short || "Other";
      if (!m.has(k)) m.set(k, { w: 0, l: 0, t: 0 });
      const s = m.get(k);
      if (g._result === "W") s.w++;
      else if (g._result === "L") s.l++;
      else s.t++;
    }
    return m;
  }, [games]);

  return (
    <>
      <div
        className={`sheet-backdrop${open ? " open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`sheet h2h-sheet${open ? " open" : ""}`}
        role="dialog"
        aria-label={opponentName ? `Head-to-head vs ${opponentName}` : undefined}
        aria-hidden={!open}
      >
        <div className="sheet-handle" />

        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h3>vs {opponentName || ""}</h3>
            <div className="sub" style={{ marginBottom: 0 }}>Season head-to-head</div>
          </div>
          <button className="h2h-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading ? (
          <div style={{ padding: "24px 0", color: "var(--muted)", textAlign: "center" }}>
            Loading history…
          </div>
        ) : !games || games.length === 0 ? (
          <div style={{ padding: "24px 0", color: "var(--muted)", textAlign: "center" }}>
            No historical games found vs {opponentName}.
          </div>
        ) : (
          <>
            {/* Summary stat boxes */}
            <div className="h2h-summary-row">
              <div className="h2h-stat">
                <div className={`h2h-record${wins > losses ? " win" : losses > wins ? " loss" : ""}`}>
                  {wins}–{losses}{ties > 0 ? `–${ties}` : ""}
                </div>
                <div className="h2h-label">Record</div>
              </div>
              <div className="h2h-stat">
                <div className={`h2h-record${totalGoalDiff > 0 ? " win" : totalGoalDiff < 0 ? " loss" : ""}`}>
                  {totalGoalDiff > 0 ? "+" : ""}{totalGoalDiff}
                </div>
                <div className="h2h-label">Goal Diff</div>
              </div>
              <div className="h2h-stat">
                <div className="h2h-record">{games.length}</div>
                <div className="h2h-label">Games</div>
              </div>
            </div>

            {/* Subteam breakdown — only shown when multiple subteams played this opponent */}
            {bySubteam.size > 1 && (
              <div className="h2h-breakdown">
                {[...bySubteam.entries()].map(([team, r]) => (
                  <div key={team} className="h2h-breakdown-row">
                    <span className="h2h-breakdown-team">{team}</span>
                    <span className={`h2h-breakdown-rec${r.w > r.l ? " win" : r.l > r.w ? " loss" : ""}`}>
                      {r.w}–{r.l}{r.t > 0 ? `–${r.t}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Games list */}
            <div className="h2h-games-hdr">
              <span>All {games.length} game{games.length !== 1 ? "s" : ""}</span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>Most recent first</span>
            </div>
            <ul className="h2h-game-list">
              {games.map((g) => (
                <li
                  key={g.game_id}
                  className={`h2h-game-row${g._result === "W" ? " win" : g._result === "L" ? " loss" : ""}`}
                >
                  <div className="h2h-game-date">{g._dateLabel}</div>
                  <div className="h2h-game-info">
                    <div className="h2h-game-loc">{g.location}</div>
                    {g.team_short && <div className="meta">{g.team_short}</div>}
                  </div>
                  <div className="h2h-game-score">{g._narwhalScore}–{g._oppScore}</div>
                  <span className={`h2h-badge${g._result === "W" ? " win" : g._result === "L" ? " loss" : " tie"}`}>
                    {g._result}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <button className="sheet-close" onClick={onClose}>Close</button>
      </aside>
    </>
  );
}
