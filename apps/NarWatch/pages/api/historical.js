/**
 * NarWatch — Historical Data API
 *
 * GET /api/historical                                   → full summary bundle
 * GET /api/historical?refresh=1                         → re-harvest + recompute (admin)
 * GET /api/historical?view=player_stats                 → all-season player stats
 * GET /api/historical?view=player_stats&weekKey=YYYY-WN → per-tournament player stats
 * GET /api/historical?view=team_record                  → just team_record
 * GET /api/historical?view=tournaments                  → just tournament_summary
 * GET /api/historical?view=players                      → raw players list
 * GET /api/historical?view=games                        → raw games list
 *
 * weekKey (ISO week, e.g. "2026-W16") filters player_stats to only the games
 * that fall within that calendar week. Returns the same shape as the all-season
 * player_stats response so the client can reuse LeaderboardTab unchanged.
 * Cache-Control for weekKey requests is 60s (live tournament data).
 *
 * Caching strategy:
 *   - data/ files are committed to git as the "seed" dataset.
 *   - In prod, these are static files on disk — reads are essentially free.
 *   - ?refresh=1 re-runs the harvest + aggregate pipeline server-side.
 *   - Cache-Control: public, max-age=3600, s-maxage=3600 (CDN caches 1 hour).
 *   - After a ?refresh=1 run, the response reflects the new data immediately.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const DATA_DIR = path.join(process.cwd(), "data");
const SCRIPTS_DIR = path.join(process.cwd(), "scripts");

function readDataFile(name) {
  const filePath = path.join(DATA_DIR, name);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Convert an ISO weekKey ("YYYY-WN") to a { startDate, endDate } pair of
 * "YYYY-MM-DD" strings representing Monday and Sunday of that week.
 * Returns null if the format is invalid.
 */
function isoWeekToDateRange(weekKey) {
  const m = weekKey && weekKey.match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  if (week < 1 || week > 53) return null;

  // Jan 4 is always in ISO week 1 (by definition).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // ISO day-of-week: Mon=1 … Sun=7. getUTCDay() gives Sun=0 … Sat=6.
  const dow = jan4.getUTCDay() || 7;
  // Monday of week 1
  const week1Mon = new Date(jan4.getTime() - (dow - 1) * 86_400_000);
  // Monday of target week
  const targetMon = new Date(week1Mon.getTime() + (week - 1) * 7 * 86_400_000);
  // Sunday of target week
  const targetSun = new Date(targetMon.getTime() + 6 * 86_400_000);

  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(targetMon), endDate: fmt(targetSun) };
}

function runScript(scriptName, timeoutMs = 120_000) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  execFileSync("node", [scriptPath], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    stdio: "inherit",
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { refresh, view, weekKey } = req.query;

  // ── ?refresh=1 — re-harvest and recompute ────────────────────────────────
  if (refresh === "1") {
    try {
      console.log("[historical] Running harvest + aggregate pipeline…");
      runScript("harvest-niwp.js");
      runScript("normalize-teams.js");
      runScript("compute-aggregates.js");
      console.log("[historical] Pipeline complete.");
    } catch (err) {
      console.error("[historical] Pipeline error:", err.message);
      return res.status(500).json({ error: "refresh_failed", detail: err.message });
    }
  }

  // ── Read pre-computed aggregates from disk ───────────────────────────────
  const meta = readDataFile("meta.json");

  // If no data exists at all, return a helpful error
  if (!meta && !readDataFile("games.json")) {
    return res.status(503).json({
      error: "data_not_initialized",
      message: "Run GET /api/historical?refresh=1 to harvest data from NIWP API.",
    });
  }

  // ── ?view=X — serve a specific slice ─────────────────────────────────────
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  switch (view) {
    case "player_stats": {
      // ── weekKey filter: aggregate stats for a single ISO week ─────────────
      if (weekKey) {
        const range = isoWeekToDateRange(weekKey);
        if (!range) return res.status(400).json({ error: "invalid_weekKey", weekKey });

        const allGames = readDataFile("games.json");
        if (!allGames) return res.status(404).json({ error: "not_found", file: "games.json" });

        // Filter games whose game_date falls within the ISO week (date comparison only).
        const weekGames = allGames.filter((g) => {
          if (!g.game_date) return false;
          const dateStr = g.game_date.slice(0, 10); // "YYYY-MM-DD"
          return dateStr >= range.startDate && dateStr <= range.endDate;
        });

        if (!weekGames.length) {
          return res.status(200).json({ meta, player_season_stats: [], weekKey, games_found: 0 });
        }

        // Aggregate per-player across all week games.
        const playerMap = new Map();
        for (const game of weekGames) {
          const statsData = readDataFile(`stats_${game.game_id}.json`) || [];
          const homeScore = parseInt(game.home_score, 10) || 0;
          const awayScore = parseInt(game.away_score, 10) || 0;
          // home_team is always CDA in the NIWP data set.
          const isWin = homeScore > awayScore;
          for (const stat of statsData) {
            const key = stat.player_id;
            if (!playerMap.has(key)) {
              playerMap.set(key, {
                player_id:   stat.player_id,
                player_name: stat.player_name,
                cap_number:  stat.cap_number,
                team_id:     stat.team_id,
                games_played: 0,
                wins:         0,
                losses:       0,
                goals:        0,
                assists:      0,
                steals:       0,
                blocks:       0,
                kickouts:     0,
              });
            }
            const p = playerMap.get(key);
            p.games_played++;
            if (isWin) p.wins++; else p.losses++;
            p.goals    += parseInt(stat.goals, 10)    || 0;
            p.assists  += parseInt(stat.assists, 10)  || 0;
            p.steals   += parseInt(stat.steals, 10)   || 0;
            p.blocks   += parseInt(stat.blocks, 10)   || 0;
            p.kickouts += parseInt(stat.kickouts, 10) || 0;
          }
        }

        const result = [...playerMap.values()].map((p) => ({
          ...p,
          win_pct: p.games_played > 0 ? p.wins / p.games_played : 0,
          avg_goals_per_game:   p.games_played > 0 ? p.goals   / p.games_played : 0,
          avg_assists_per_game: p.games_played > 0 ? p.assists / p.games_played : 0,
        })).sort((a, b) => b.goals - a.goals);

        res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        return res.status(200).json({
          meta,
          player_season_stats: result,
          weekKey,
          games_found: weekGames.length,
        });
      }

      // ── All-season stats ──────────────────────────────────────────────────
      const data = readDataFile("player_season_stats.json");
      if (!data) return res.status(404).json({ error: "not_found", file: "player_season_stats.json" });
      return res.status(200).json({ meta, player_season_stats: data });
    }
    case "team_record": {
      const data = readDataFile("team_record.json");
      if (!data) return res.status(404).json({ error: "not_found", file: "team_record.json" });
      return res.status(200).json(data);
    }
    case "tournaments": {
      const data = readDataFile("tournament_summary.json");
      if (!data) return res.status(404).json({ error: "not_found", file: "tournament_summary.json" });
      return res.status(200).json({ meta, tournaments: data });
    }
    case "players": {
      const data = readDataFile("players.json");
      if (!data) return res.status(404).json({ error: "not_found", file: "players.json" });
      return res.status(200).json({ meta, players: data });
    }
    case "games": {
      const data = readDataFile("games.json");
      if (!data) return res.status(404).json({ error: "not_found", file: "games.json" });
      // Optional ?opponent_id= or ?opponent_name= filter
      const { opponent_id, opponent_name } = req.query;
      if (opponent_id) {
        const filtered = data.filter((g) => g.opponent_id === opponent_id);
        return res.status(200).json({ meta, games: filtered, opponent_id });
      }
      if (opponent_name) {
        const norm = (s) => String(s || "").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
        const target = norm(opponent_name);
        const filtered = data.filter(
          (g) => norm(g.opponent_display_name) === target || norm(g.away_team) === target
        );
        return res.status(200).json({ meta, games: filtered, opponent_name });
      }
      return res.status(200).json({ meta, games: data });
    }
    default: {
      // Return the full summary bundle (no raw per-game stats — too large)
      const teamRecord = readDataFile("team_record.json");
      const playerStats = readDataFile("player_season_stats.json");
      const tournaments = readDataFile("tournament_summary.json");

      return res.status(200).json({
        meta,
        team_record: teamRecord ?? null,
        // Top 20 players by goals for quick display; use ?view=player_stats for full list
        top_players: playerStats ? playerStats.slice(0, 20) : null,
        tournaments: tournaments ?? null,
      });
    }
  }
}
