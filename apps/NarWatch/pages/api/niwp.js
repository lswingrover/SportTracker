// NarWatch: NIWP WordPress REST API adapter.
//
// Fetches live game and player data from the North Idaho Water Polo
// custom WordPress REST API (northidahowaterpolo.org). No auth required.
//
// ENDPOINTS CONSUMED:
//   GET /wp-json/niwp-stats/v1/games
//   GET /wp-json/niwp-stats/v1/games/{id}/stats
//   GET /wp-json/niwp-stats/v1/players
//
// TEAM PREFIX FILTER (?team= query param):
//   B   = Boys Varsity (default)
//   G   = Girls Varsity
//   BJV = Boys JV
//   GJV = Girls JV
//
// OUTPUT: same JSON shape as tournament.js / sheets.js so the frontend
// is unaffected. Also includes _pollSchedule for adaptive client polling.

import { computePollSchedule } from "../../lib/pollSchedule.js";
import { deriveStandings } from "@sport-tracker/core/gameNorm.js";

const NIWP_BASE = "https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1";
const CACHE_TTL_MS = 60 * 1000;

// CDA team name fragments we look for in home_team / away_team
const CDA_PATTERNS = ["cda", "coeur d'alene", "north idaho", "narwhal", "niwp"];

// Subteam key → human label (matches NIWP_TEAM_FILTERS on the frontend)
const SUBTEAM_LABELS = { B: "18U Boys", G: "18U Girls", BJV: "JV Boys", GJV: "JV Girls", D: "Dev" };

// Location string patterns → IANA timezone. Order matters (first match wins).
const VENUE_TZ_MAP = [
  [/gresham|hillsboro|portland|newberg|eugene|bend|oregon|\bor\b/i, "America/Los_Angeles"],
  [/cda|coeur|idaho|boise|lewiston|\bid\b/i,                       "America/Los_Angeles"],
  [/cascade|dare to dream|kroc|spokane|seattle|washington|\bwa\b/i,"America/Los_Angeles"],
  [/dallas|lewisville|houston|austin|texas|\btx\b/i,               "America/Chicago"],
  [/denver|colorado|utah/i,                                         "America/Denver"],
  [/phoenix|arizona/i,                                              "America/Phoenix"],
  [/florida|orlando|tampa|miami|jacksonville|\bfl\b|georgia|atlanta|carolina|virginia/i, "America/New_York"],
];

// Module-level cache keyed by team prefix ("B", "G", etc.)
const cacheMap = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Parse a NIWP date string as Pacific local time.
//
// The NIWP WordPress API stores game_date as a bare datetime in Pacific
// wall-clock time ("2026-04-17 18:30:00") with NO timezone offset. Passing
// such a string to new Date() on a UTC server (Vercel) treats it as UTC,
// shifting displayed times by 7–8 hours.
//
// Fix: detect bare strings (no Z / ±hh:mm), normalise to ISO, then try
// PDT (-07:00). Verify with Intl that the date really falls in PDT; if not
// (winter → PST), re-parse with -08:00 instead.
function parseDateAsPT(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // Already has TZ info — trust it.
  if (/[Zz]$/.test(s) || /[+-]\d{1,2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  // Bare date-only (YYYY-MM-DD) — use noon PT to avoid midnight UTC roll-back.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T12:00:00-07:00");
    return isNaN(d.getTime()) ? null : d;
  }
  // Bare datetime — interpret as PT wall clock.
  const iso = s.replace(" ", "T");
  const attempt = new Date(iso + "-07:00"); // assume PDT first
  if (isNaN(attempt.getTime())) return null;
  // Verify DST: if this date is actually in PST (winter), -07:00 is wrong.
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  }).formatToParts(attempt).find((p) => p.type === "timeZoneName")?.value || "";
  return tzLabel.includes("PDT") ? attempt : new Date(iso + "-08:00");
}

// Derive which NIWP subteam a game belongs to from the CDA team's name.
// Returns one of: "B" | "G" | "BJV" | "GJV" | "D" | null
function deriveSubteam(cdaTeamName) {
  if (!cdaTeamName) return null;
  const n = cdaTeamName.toLowerCase();
  const isJV    = /\bjv\b/.test(n);
  const hasGirl = /girl/.test(n);
  const hasBoy  = /boy/.test(n);
  const isDev   = /\bdev\b/.test(n) || /master/.test(n);
  const isCoEd  = /co.?ed/.test(n);
  if (isDev || isCoEd)          return "D";
  if (isJV && hasGirl)          return "GJV";
  if (isJV)                     return "BJV"; // JV without "girl" = boys JV
  if (hasGirl)                  return "G";
  if (hasBoy)                   return "B";
  // "V" at end of name = Varsity → default to boys
  if (/ v$/.test(n) || /\bvarsity\b/.test(n)) return "B";
  return null;
}

// Infer IANA timezone from a NIWP location string.
// Defaults to America/Los_Angeles (PT) since nearly all NIWP venues are Pacific.
function inferVenueTz(location) {
  if (!location) return "America/Los_Angeles";
  for (const [pattern, tz] of VENUE_TZ_MAP) {
    if (pattern.test(location)) return tz;
  }
  return "America/Los_Angeles";
}

function isCDATeam(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return CDA_PATTERNS.some((p) => lower.includes(p));
}

// Player name prefix → team prefix map
//   "B - "   → "B"
//   "G - "   → "G"
//   "BJV - " → "BJV"
//   "GJV - " → "GJV"
function playerPrefix(playerName) {
  if (!playerName) return null;
  const m = playerName.match(/^([A-Z]+)\s*-\s*/);
  return m ? m[1] : null;
}

// Group games into "tournaments": games in the same calendar week
// (Mon–Sun) at the same general location cluster.
function groupIntoTournaments(games) {
  const byWeek = new Map();
  for (const g of games) {
    const d = parseDateAsPT(g.game_date);
    if (!d) continue;
    // ISO week key: YYYY-Www
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const weekNum = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, []);
    byWeek.get(weekKey).push(g);
  }
  return byWeek;
}

// Derive location from the most common location string in a game group
function dominantLocation(games) {
  const counts = {};
  for (const g of games) {
    const loc = g.location || "Unknown";
    counts[loc] = (counts[loc] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// Format a game_date string (YYYY-MM-DD or ISO) into a short label
function shortDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchFromNIWP(teamPrefix, requestedWeekKey) {
  const prefix = (teamPrefix || "B").toUpperCase();

  // Fetch games and players in parallel
  const [gamesRes, playersRes] = await Promise.all([
    fetch(`${NIWP_BASE}/games`, {
      headers: { Accept: "application/json" },
      // Node 18+ supports signal for timeout
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    }),
    fetch(`${NIWP_BASE}/players`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    }),
  ]);

  if (!gamesRes.ok) throw new Error(`NIWP games API ${gamesRes.status}`);
  const gamesJson = await gamesRes.json();
  // API returns {success, data:[...]} envelope
  const allGames = Array.isArray(gamesJson) ? gamesJson : (gamesJson.data || []);

  // Players are optional — don't fail if unavailable
  let allPlayers = [];
  if (playersRes.ok) {
    try {
      const playersJson = await playersRes.json();
      allPlayers = Array.isArray(playersJson) ? playersJson : (playersJson.data || []);
    } catch {}
  }

  // Build player-prefix lookup: player_id → prefix
  const playerPrefixMap = new Map();
  for (const p of allPlayers) {
    const pfx = playerPrefix(p.player_name);
    if (pfx) playerPrefixMap.set(String(p.player_id), pfx);
  }

  // Filter to games that involve a CDA/NIWP team
  const cdaGames = allGames.filter(
    (g) => isCDATeam(g.home_team) || isCDATeam(g.away_team)
  );

  // Compute adaptive poll schedule from ALL CDA games (not just current week).
  // Needs timeISO — same normalization used in normalized game objects below.
  const pollScheduleInput = cdaGames.map((g) => {
    const d = parseDateAsPT(g.game_date);
    return { timeISO: d ? d.toISOString() : null };
  });
  const pollSchedule = computePollSchedule(pollScheduleInput);

  // Group by calendar week to form pseudo-tournaments
  const byWeek = groupIntoTournaments(cdaGames);

  // Sort weeks
  const sortedWeeks = Array.from(byWeek.keys()).sort();
  if (sortedWeeks.length === 0) {
    // No games found — return empty payload
    return buildEmptyPayload(prefix);
  }

  // Resolve which week to serve:
  //   - If caller passes ?weekKey=YYYY-Www and it exists, use it.
  //   - Otherwise fall back to the most recent week.
  const weekKey = (requestedWeekKey && byWeek.has(requestedWeekKey))
    ? requestedWeekKey
    : sortedWeeks[sortedWeeks.length - 1];
  const weekGames = byWeek.get(weekKey);

  const location = dominantLocation(weekGames);
  const firstDate = weekGames[0]?.game_date || null;
  const lastDate  = weekGames[weekGames.length - 1]?.game_date || firstDate;

  // Normalize each game into the standard shape
  const now = new Date();
  const normalizedGames = weekGames.map((g) => {
    const home = g.home_team || "";
    const away = g.away_team || "";
    const isHome = isCDATeam(home);
    // Raw opponent name — the side that is NOT the CDA/NIWP team.
    const rawOpponent = (isHome ? away : home).trim();
    // Derive which NIWP subteam this game belongs to (B/G/BJV/GJV/D).
    const cdaTeamName = isHome ? home : away;
    const subteam = deriveSubteam(cdaTeamName);

    const usScore   = isHome ? g.home_score : g.away_score;
    const themScore = isHome ? g.away_score : g.home_score;

    const hasScores =
      usScore !== null && usScore !== undefined && usScore !== "" &&
      themScore !== null && themScore !== undefined && themScore !== "" &&
      !isNaN(Number(usScore)) && !isNaN(Number(themScore));

    const us   = hasScores ? Number(usScore)   : null;
    const them = hasScores ? Number(themScore) : null;

    // Parse game_date as Pacific local time (see parseDateAsPT).
    const d = parseDateAsPT(g.game_date);
    const gameTime = d ? d.toISOString() : null;

    const done = hasScores || (gameTime ? new Date(gameTime) < now : false);

    let result = null;
    if (hasScores) result = us > them ? "W" : "L";

    const sets = hasScores ? [{ us, them }] : [];
    const score = hasScores ? `${us}–${them}` : null;

    return {
      id:       String(g.game_id),
      opponent: rawOpponent || "Unknown",
      subteam,
      timeISO:  gameTime,
      court:    g.location || null,
      done,
      result,
      sets,
      score,
      round:    null,
      notes:    null,
      _source:  "niwp",
      _gameId:  g.game_id,
    };
  });

  // Filter by team prefix if we have player data to cross-reference.
  // Without player data we show all CDA games.
  // (We can't reliably filter by prefix at the game level — the prefix
  //  lives on players, not on games. We include all CDA games.)

  const doneGames = normalizedGames.filter((g) => g.done);
  const wins      = doneGames.filter((g) => g.result === "W").length;
  const losses    = doneGames.filter((g) => g.result === "L").length;
  let goalDiff    = 0;
  for (const g of doneGames) {
    for (const s of g.sets || []) {
      goalDiff += (s.us || 0) - (s.them || 0);
    }
  }

  // Derive standings from game results
  const standings = deriveStandings(normalizedGames, "North Idaho Narwhals", "narwhals");

  const tournamentId = `niwp-${weekKey}`;
  const tournamentName = location && location !== "Unknown"
    ? `${location} · ${shortDate(firstDate)}`
    : `NIWP Tournament · ${shortDate(firstDate)}`;

  // Infer the venue timezone from the dominant location string.
  const venueTz = inferVenueTz(location);

  return {
    teamName:     "North Idaho Narwhals",
    teamId:       "narwhals",
    tournamentId,
    event: {
      id:        tournamentId,
      name:      tournamentName,
      location,
      startDate: firstDate,
      endDate:   lastDate,
      isOver:    doneGames.length === normalizedGames.length && normalizedGames.length > 0,
    },
    record:   { wins, losses },
    goalDiff,
    games:    normalizedGames,
    standings,
    teams:                [],
    nextGame:             null,
    nextEvent:            null,
    liveGame:             null,
    isOver:               doneGames.length === normalizedGames.length && normalizedGames.length > 0,
    isLive:               false,
    pool:                 null,
    brackets:             [],
    workAssignments:      [],
    teamWatchNowLink:     null,
    projectedDone:        null,
    projectedDoneSource:  null,
    nextAssignmentsCount: 0,
    venueTz,
    scrapedAt:            new Date().toISOString(),
    remoteTimestamp:      new Date().toISOString(),
    cached:               false,
    _dataSource:          "niwp",
    _teamPrefix:          prefix,
    _weekKey:             weekKey,
    _pollSchedule:        pollSchedule,
  };
}

function buildEmptyPayload(prefix) {
  return {
    teamName:     "North Idaho Narwhals",
    teamId:       "narwhals",
    tournamentId: `niwp-empty-${prefix}`,
    event:        { id: "niwp-empty", name: "NIWP Tournament", location: null, startDate: null, endDate: null, isOver: false },
    record:       { wins: 0, losses: 0 },
    goalDiff:     0,
    games:        [],
    standings:    [],
    teams: [], nextGame: null, nextEvent: null, liveGame: null,
    isOver: false, isLive: false, pool: null, brackets: [],
    workAssignments: [], teamWatchNowLink: null, projectedDone: null,
    projectedDoneSource: null, nextAssignmentsCount: 0,
    scrapedAt: new Date().toISOString(),
    remoteTimestamp: new Date().toISOString(),
    cached: false,
    _dataSource: "niwp",
    _teamPrefix: prefix,
  };
}

// ─── API route handler ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const teamPrefix  = String(req.query?.team || "B").toUpperCase();
  const weekKey     = req.query?.weekKey ? String(req.query.weekKey) : null;
  const force       = req.query?.force === "1";
  const now         = Date.now();
  // Cache key includes weekKey so each week is cached independently
  const cacheKey    = weekKey ? `${teamPrefix}:${weekKey}` : teamPrefix;
  const entry       = cacheMap.get(cacheKey);

  if (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json({ ...entry.payload, cached: true });
    return;
  }

  try {
    const payload = await fetchFromNIWP(teamPrefix, weekKey);
    cacheMap.set(cacheKey, { payload, fetchedAt: now });
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json(payload);
  } catch (err) {
    // Stale-on-error fallback
    if (entry) {
      console.error("[niwp] fetch failed, serving stale cache:", err.message);
      res.status(200).json({
        ...entry.payload,
        cached:         true,
        _staleError:    String(err.message),
        _staleServedAt: new Date().toISOString(),
      });
      return;
    }
    console.error("[niwp] fetch failed, no cache:", err.message);
    res.status(502).json({ error: "niwp_fetch_failed", detail: String(err.message) });
  }
}
