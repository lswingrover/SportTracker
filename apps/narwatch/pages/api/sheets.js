// NarWatch: Google Sheets live data integration.
//
// PURPOSE: A team parent opens a shared Google Sheet during a tournament,
// types in scores as games finish, and NarWatch polls this endpoint every
// 60 seconds to display live results — no dependency on tournament software.
//
// SETUP (5 minutes):
//   1. Copy the template sheet (see docs/SHEETS_SETUP.md) and share it as
//      "Anyone with the link can view".
//   2. Create a Google Cloud API key restricted to the Sheets API.
//   3. Add to your .env:
//        GOOGLE_SHEETS_ID=<sheet-id-from-url>
//        GOOGLE_SHEETS_API_KEY=<your-api-key>
//
// SHEET STRUCTURE (three tabs — see docs/SHEETS_SETUP.md for full schema):
//   "Config"    – key/value pairs: tournament metadata
//   "Games"     – one row per game; headers in row 1
//   "Standings" – one row per team; auto-derived if left blank
//
// AUTH: public sheet + API key (read-only). No OAuth needed.
// CACHE: 60-second TTL (matches the UI's polling interval).

import { deriveStandings } from "@sport-tracker/core/gameNorm.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const CACHE_TTL_MS = 60 * 1000;

// Module-level cache (survives between requests in the same Node process).
let _cache = null;
let _cachedAt = 0;

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchRange(sheetId, apiKey, range) {
  const url = `${SHEETS_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sheets API ${res.status} for "${range}": ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.values || [];
}

// ─── Config tab parser ────────────────────────────────────────────────────────
// Rows are [key, value]. Keys are normalized to snake_case.

function parseConfig(rows) {
  const cfg = {};
  for (const row of rows) {
    if (row.length >= 2 && row[0]) {
      const key = String(row[0]).trim().toLowerCase().replace(/\s+/g, "_");
      cfg[key] = String(row[1] || "").trim();
    }
  }
  return cfg;
}

// ─── Games tab parser ─────────────────────────────────────────────────────────
// Row 1: headers (order-flexible, case-insensitive).
// Required: Opponent. Everything else degrades gracefully.
//
// Canonical header names:
//   Game ID | Date | Time | Round | Opponent | NIWP Score | Opp Score
//   | W/L | Done | Court | Notes

const GAME_HEADER_ALIASES = {
  game_id:    ["game id", "id", "game_id", "#"],
  date:       ["date", "game date"],
  time:       ["time", "game time", "start time", "start"],
  round:      ["round", "phase", "bracket", "stage"],
  opponent:   ["opponent", "opp", "vs", "vs."],
  us_score:   ["niwp score", "niwp", "us score", "our score", "score (niwp)", "narwhals score", "home"],
  them_score: ["opp score", "opponent score", "their score", "them score", "away"],
  wl:         ["w/l", "result", "w / l", "outcome"],
  done:       ["done", "final", "complete", "completed", "finished"],
  court:      ["court", "field", "pool", "lane", "location"],
  notes:      ["notes", "note", "comment"],
};

function makeColFinder(headers) {
  return function col(name) {
    const aliases = GAME_HEADER_ALIASES[name] || [name];
    for (const alias of aliases) {
      const idx = headers.indexOf(alias.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };
}

function parseGames(rows, fallbackDate) {
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const col = makeColFinder(headers);

  const games = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const get = (name) => {
      const idx = col(name);
      return idx >= 0 ? String(row[idx] || "").trim() : "";
    };

    const opponent = get("opponent");
    if (!opponent) continue; // blank row — skip

    // ── Timestamp ──────────────────────────────────────────────────────────
    let timeISO = null;
    const dateStr = get("date") || fallbackDate || "";
    const timeStr = get("time") || "";
    if (dateStr) {
      try {
        const combined = timeStr ? `${dateStr} ${timeStr}` : dateStr;
        const d = new Date(combined);
        if (!isNaN(d.getTime())) timeISO = d.toISOString();
      } catch (_) { /* leave null */ }
    }

    // ── Scores ─────────────────────────────────────────────────────────────
    const usRaw   = get("us_score");
    const themRaw = get("them_score");
    const hasScores = usRaw !== "" && themRaw !== "" && !isNaN(Number(usRaw)) && !isNaN(Number(themRaw));
    const usScore   = hasScores ? Number(usRaw)   : null;
    const themScore = hasScores ? Number(themRaw) : null;

    // ── Done ───────────────────────────────────────────────────────────────
    const doneStr = get("done").toLowerCase();
    const done =
      doneStr === "true" || doneStr === "yes" || doneStr === "1" || hasScores;

    // ── Result ─────────────────────────────────────────────────────────────
    let result = null;
    const wlRaw = get("wl").toUpperCase().trim();
    if (wlRaw === "W" || wlRaw === "WIN")                     result = "W";
    else if (wlRaw === "L" || wlRaw === "LOSS" || wlRaw === "LOSE") result = "L";
    else if (hasScores) result = usScore > themScore ? "W" : "L";

    // ── Sets (water polo: scores are cumulative totals, not per-quarter) ───
    // We store them as a single-element "set" so the UI renders the total.
    // If a sheet manager enters per-quarter scores in separate columns,
    // that can be added as a future enhancement.
    const sets = hasScores ? [{ us: usScore, them: themScore }] : [];

    games.push({
      id:       get("game_id") || `g-${i}`,
      opponent,
      timeISO,
      court:    get("court")  || null,
      done,
      result,
      sets,
      score:    hasScores ? `${usScore}–${themScore}` : null,
      round:    get("round")  || null,
      notes:    get("notes")  || null,
      _source:  "sheets",
    });
  }
  return games;
}

// ─── Standings tab parser ─────────────────────────────────────────────────────
// Row 1: headers. Columns: Rank | Team Name | Wins | Losses | Goal Diff | Is Us

const STANDINGS_HEADER_ALIASES = {
  rank:      ["rank", "#", "place"],
  team:      ["team name", "team", "name", "club"],
  wins:      ["wins", "w"],
  losses:    ["losses", "l", "loss"],
  goal_diff: ["goal diff", "gd", "goal differential", "+/-", "goal difference"],
  is_us:     ["is us", "us", "niwp", "narwhals", "our team"],
};

function makeStandingsColFinder(headers) {
  return function col(name) {
    const aliases = STANDINGS_HEADER_ALIASES[name] || [name];
    for (const alias of aliases) {
      const idx = headers.indexOf(alias.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };
}

function parseStandings(rows, teamName) {
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const col = makeStandingsColFinder(headers);

  const standings = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const get = (name) => {
      const idx = col(name);
      return idx >= 0 ? String(row[idx] || "").trim() : "";
    };
    const name = get("team");
    if (!name) continue;

    // "Is Us" — explicit flag, or auto-detect by matching the team name
    const isUsStr = get("is_us").toLowerCase();
    const isUs =
      isUsStr === "true" || isUsStr === "yes" || isUsStr === "1" ||
      (!!teamName &&
        name.toLowerCase().includes(
          teamName.toLowerCase().split(/\s+/)[0].toLowerCase()
        ));

    standings.push({
      teamId:      name.toLowerCase().replace(/\s+/g, "-"),
      teamName:    name,
      isUs,
      rank:        Number(get("rank"))      || null,
      matchesWon:  Number(get("wins"))      || 0,
      matchesLost: Number(get("losses"))    || 0,
      goalDiff:    Number(get("goal_diff")) || 0,
      setPercent:  0, // not tracked in the basic sheet schema
      earnedBid:   false,
      bidAlias:    null,
    });
  }
  return standings;
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export async function fetchFromSheets() {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const apiKey  = process.env.GOOGLE_SHEETS_API_KEY;

  if (!sheetId || !apiKey) {
    throw new Error(
      "Missing env vars: GOOGLE_SHEETS_ID and GOOGLE_SHEETS_API_KEY are both required"
    );
  }

  // Fetch all three tabs in parallel; Standings is optional (swallow 404).
  const [configRows, gameRows, standingRows] = await Promise.all([
    fetchRange(sheetId, apiKey, "Config!A:B"),
    fetchRange(sheetId, apiKey, "Games!A:K"),
    fetchRange(sheetId, apiKey, "Standings!A:G").catch(() => []),
  ]);

  const cfg        = parseConfig(configRows);
  const teamName   = cfg.team_name    || "North Idaho Narwhals";
  const teamId     = cfg.team_id      || "narwhals";
  const tournamentId = cfg.tournament_id || "sheets-live";

  const games      = parseGames(gameRows, cfg.date);
  const rawStandings = parseStandings(standingRows, teamName);
  const standings  = rawStandings.length > 0
    ? rawStandings
    : deriveStandings(games, teamName, teamId);

  // Compute record + goal diff
  const doneGames = games.filter((g) => g.done);
  const wins      = doneGames.filter((g) => g.result === "W").length;
  const losses    = doneGames.filter((g) => g.result === "L").length;
  let goalDiff    = 0;
  for (const g of doneGames) {
    if (Array.isArray(g.sets)) {
      for (const s of g.sets) {
        goalDiff += (s.us || 0) - (s.them || 0);
      }
    }
  }

  return {
    teamName,
    teamId,
    tournamentId,
    event: {
      id:        tournamentId,
      name:      cfg.tournament_name || "Tournament",
      location:  cfg.location        || null,
      startDate: cfg.date            || null,
      endDate:   cfg.end_date || cfg.date || null,
      isOver:    false,
    },
    record:   { wins, losses },
    goalDiff,
    games,
    standings,
    teams:                [],
    nextGame:             null,
    nextEvent:            null,
    liveGame:             null,
    isOver:               false,
    isLive:               false,
    pool:                 null,
    brackets:             [],
    workAssignments:      [],
    teamWatchNowLink:     null,
    projectedDone:        null,
    projectedDoneSource:  null,
    nextAssignmentsCount: 0,
    scrapedAt:            new Date().toISOString(),
    remoteTimestamp:      new Date().toISOString(),
    cached:               false,
    _dataSource:          "google-sheets",
  };
}

// ─── API route handler ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const force = req.query?.force === "1";
  const now   = Date.now();

  if (!force && _cache && now - _cachedAt < CACHE_TTL_MS) {
    res.status(200).json({ ..._cache, cached: true });
    return;
  }

  try {
    const payload = await fetchFromSheets();
    _cache    = payload;
    _cachedAt = now;
    res.status(200).json(payload);
  } catch (err) {
    // Serve stale cache on error rather than returning 502 to the PWA
    if (_cache) {
      console.error("[sheets] fetch failed, serving stale cache:", err.message);
      res.status(200).json({
        ..._cache,
        cached:        true,
        _staleError:   String(err.message),
        _staleServedAt: new Date().toISOString(),
      });
      return;
    }
    console.error("[sheets] fetch failed, no cache:", err.message);
    res.status(502).json({
      error:  "sheets_fetch_failed",
      detail: String(err.message),
    });
  }
}
