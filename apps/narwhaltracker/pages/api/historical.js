/**
 * NarWatch — Historical Data API
 *
 * GET /api/historical                    → serve pre-computed aggregates (fast, no live fetch)
 * GET /api/historical?refresh=1          → re-fetch from NIWP API and recompute (admin)
 * GET /api/historical?view=player_stats  → just player_season_stats
 * GET /api/historical?view=team_record   → just team_record
 * GET /api/historical?view=tournaments   → just tournament_summary
 * GET /api/historical?view=players       → raw players list
 * GET /api/historical?view=games         → raw games list
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

  const { refresh, view } = req.query;

  // ── ?refresh=1 — re-harvest and recompute ────────────────────────────────
  if (refresh === "1") {
    try {
      console.log("[historical] Running harvest + aggregate pipeline…");
      runScript("harvest-niwp.js");
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
