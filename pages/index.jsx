import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";

const REFRESH_MS = 2 * 60 * 1000;

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

function buildICS(events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//208 Tracker//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const e of events) {
    if (!e.timeISO) continue;
    const start = icsDate(e.timeISO);
    const end = icsDate(
      new Date(new Date(e.timeISO).getTime() + 75 * 60 * 1000).toISOString()
    );
    const uid = `${e.id || start}@208tracker`;
    const summary = e.summary || `vs ${e.opponent || "TBD"}`;
    const location = e.court || "TBD";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${summary}`,
      `LOCATION:${location}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
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

function detectChanges(prev, next) {
  const changes = new Set();
  if (!prev || !Array.isArray(prev.games)) return changes;
  const prevById = new Map(prev.games.map((g) => [g.id, g]));
  for (const g of next.games || []) {
    const old = prevById.get(g.id);
    if (!old) continue;
    if (old.court !== g.court || old.timeISO !== g.timeISO) {
      changes.add(g.id);
    }
  }
  return changes;
}

export default function Home() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("schedule");
  const [changedIds, setChangedIds] = useState(new Set());
  const [showManual, setShowManual] = useState(false);
  const [manualGames, setManualGames] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("manualGames") || "[]");
    } catch {
      return [];
    }
  });
  const prevDataRef = useRef(null);

  async function load(force = false) {
    try {
      setLoading(true);
      const res = await fetch(`/api/tournament${force ? "?force=1" : ""}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const next = await res.json();
      const changes = detectChanges(prevDataRef.current, next);
      if (changes.size) setChangedIds(changes);
      prevDataRef.current = next;
      setData(next);
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useInterval(() => load(), REFRESH_MS);

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("manualGames", JSON.stringify(manualGames));
  }, [manualGames]);

  const games = useMemo(() => {
    const apiGames = data?.games || [];
    if (apiGames.length || !manualGames.length) return apiGames;
    return manualGames
      .map((g) => ({
        ...g,
        next: false,
      }))
      .sort((a, b) => (new Date(a.timeISO).getTime() || 0) - (new Date(b.timeISO).getTime() || 0));
  }, [data, manualGames]);

  const standings = data?.standings || [];
  const work = data?.workAssignments || [];
  const record = data?.record || { wins: 0, losses: 0 };

  const nextGame =
    data?.nextGame ||
    games.find((g) => !g.done && g.timeISO) ||
    null;

  const minutesUntil = useCountdown(nextGame?.timeISO);

  function exportAll() {
    const upcoming = games.filter((g) => !g.done && g.timeISO);
    if (!upcoming.length) return;
    const ics = buildICS(
      upcoming.map((g) => ({
        ...g,
        summary: `208 vs ${g.opponent}`,
      }))
    );
    downloadICS("208-games.ics", ics);
  }

  function exportOne(g) {
    const ics = buildICS([{ ...g, summary: `208 vs ${g.opponent}` }]);
    downloadICS(`208-${(g.opponent || "game").replace(/\s+/g, "_")}.ics`, ics);
  }

  async function shareSummary() {
    const lines = [];
    lines.push(`208 U14 Red — ${record.wins}W ${record.losses}L`);
    if (data?.poolPosition) lines.push(`Pool: ${data.poolPosition}`);
    if (nextGame) {
      lines.push(`Next: ${nextGame.time} • Ct ${nextGame.court} • vs ${nextGame.opponent}`);
    }
    const text = lines.join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: "208 Tracker", text });
      } else {
        await navigator.clipboard.writeText(text);
        alert("Copied to clipboard");
      }
    } catch {
      /* user cancelled */
    }
  }

  function addManualGame(form) {
    const entry = {
      id: `manual-${Date.now()}`,
      done: form.done,
      result: form.result || null,
      score: form.score || null,
      court: form.court || "TBD",
      opponent: form.opponent || "TBD",
      timeISO: form.timeISO || null,
      time: form.timeISO ? new Date(form.timeISO).toLocaleString() : null,
      manual: true,
    };
    setManualGames((m) => [...m, entry]);
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
            <div>
              <div className="name">208 U14 Red</div>
              <div className="sub">{data?.cached ? "Live (cached)" : "Live"}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="iconbtn" onClick={shareSummary} aria-label="Share">
              Share
            </button>
            <button
              className="iconbtn"
              onClick={() => load(true)}
              disabled={loading}
              aria-label="Refresh"
            >
              {loading ? "…" : "Refresh"}
            </button>
          </div>
        </header>

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

        {nextGame ? (
          <section className="hero">
            <h2>Next match</h2>
            <div className="opp">vs {nextGame.opponent}</div>
            <div className="meta">
              {nextGame.time} • Court {nextGame.court}
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
        ) : (
          <section className="hero empty">
            <h2>No upcoming match</h2>
            <div className="meta">
              {data?.projectedDone
                ? `Tournament looks done. Projected end: ${new Date(data.projectedDone).toLocaleString()}.`
                : "Schedule data unavailable from AES. Add games manually below."}
            </div>
          </section>
        )}

        <nav className="tabs" role="tablist">
          {[
            ["schedule", "Schedule"],
            ["standings", "Standings"],
            ["work", "Work duties"],
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
            <div className="bulk-actions">
              <button className="btn-mini" onClick={exportAll} disabled={!games.some((g) => !g.done)}>
                Export upcoming → ICS
              </button>
              <button className="btn-mini" onClick={() => setShowManual(true)}>
                Manual entry
              </button>
            </div>
            {games.length === 0 ? (
              <div className="empty">
                No games returned by AES.
                <br />
                Use “Manual entry” to add games.
              </div>
            ) : (
              <div className="list">
                {games.map((g) => (
                  <article
                    key={g.id}
                    className={`card ${g.next ? "next" : ""} ${g.result === "W" ? "win" : ""} ${g.result === "L" ? "loss" : ""}`}
                  >
                    <div className="card-row">
                      <div>
                        <div className="opp">vs {g.opponent}</div>
                        <div className="meta">
                          {g.time || "TBD"} • Ct {g.court}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {g.result === "W" && <span className="badge win">Won</span>}
                        {g.result === "L" && <span className="badge loss">Lost</span>}
                        {!g.done && g.next && <span className="badge next">Next</span>}
                        {!g.done && !g.next && <span className="badge">Upcoming</span>}
                        {changedIds.has(g.id) && <span className="badge changed">Changed</span>}
                      </div>
                    </div>
                    {g.score && <div className="meta">Score: {g.score}</div>}
                    {!g.done && g.timeISO && (
                      <div className="card-actions">
                        <button className="btn-mini" onClick={() => exportOne(g)}>
                          Add to calendar
                        </button>
                      </div>
                    )}
                  </article>
                ))}
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
                      <td>{(row.setPercent * 100).toFixed(0)}%</td>
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
                          {w.time || "TBD"} • Ct {w.court}
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
            {error && <span className="cached-pill" style={{ color: "var(--loss)" }}>{error}</span>}
          </div>
          <button className="btn-mini" onClick={() => setShowManual(true)}>
            Edit local games
          </button>
        </footer>
      </div>

      {showManual && (
        <ManualEntryModal
          existing={manualGames}
          onClose={() => setShowManual(false)}
          onAdd={addManualGame}
          onClear={() => setManualGames([])}
        />
      )}
    </>
  );
}

function ManualEntryModal({ existing, onClose, onAdd, onClear }) {
  const [opponent, setOpponent] = useState("");
  const [court, setCourt] = useState("");
  const [timeLocal, setTimeLocal] = useState("");
  const [done, setDone] = useState(false);
  const [result, setResult] = useState("W");
  const [score, setScore] = useState("");

  function submit(e) {
    e.preventDefault();
    onAdd({
      opponent,
      court,
      timeISO: timeLocal ? new Date(timeLocal).toISOString() : null,
      done,
      result: done ? result : null,
      score: done ? score : null,
    });
    setOpponent("");
    setCourt("");
    setTimeLocal("");
    setScore("");
    setDone(false);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Manual entry</h3>
        <form onSubmit={submit}>
          <div className="field">
            <label>Opponent</label>
            <input
              required
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
              placeholder="Club Selah U14 Blue"
            />
          </div>
          <div className="field">
            <label>Court</label>
            <input
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              placeholder="HUB Ct 5"
            />
          </div>
          <div className="field">
            <label>Start time</label>
            <input
              type="datetime-local"
              value={timeLocal}
              onChange={(e) => setTimeLocal(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={done}
                onChange={(e) => setDone(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              This game is already played
            </label>
          </div>
          {done && (
            <>
              <div className="field">
                <label>Result</label>
                <select value={result} onChange={(e) => setResult(e.target.value)}>
                  <option value="W">Won</option>
                  <option value="L">Lost</option>
                </select>
              </div>
              <div className="field">
                <label>Score</label>
                <input
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                  placeholder="25-22, 24-26"
                />
              </div>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
            {existing.length > 0 && (
              <button type="button" className="btn-secondary" onClick={onClear}>
                Clear all
              </button>
            )}
            <button type="submit" className="btn-primary">
              Add game
            </button>
          </div>
        </form>
        {existing.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
            {existing.length} manual game{existing.length === 1 ? "" : "s"} stored locally.
          </div>
        )}
      </div>
    </div>
  );
}
