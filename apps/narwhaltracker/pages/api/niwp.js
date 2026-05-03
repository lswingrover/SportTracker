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
// is unaffected.

const NIWP_BASE = "https://www.northidahowaterpolo.org/wp-json/niwp-stats/v1";
const CACHE_TTL_MS = 60 * 1000;

// CDA team name fragments we look for in home_team / away_team
const CDA_PATTERNS = ["cda", "coeur d'alene", "north idaho", "narwhal", "niwp"];

// Module-level cache keyed by team prefix ("B", "G", etc.)
const cacheMap = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    const d = new Date(g.game_date);
    if (isNaN(d.getTime())) continue;
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

async function fetchFromNIWP(teamPrefix) {
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

  // Group by calendar week to form pseudo-tournaments
  const byWeek = groupIntoTournaments(cdaGames);

  // Sort weeks
  const sortedWeeks = Array.from(byWeek.keys()).sort();
  if (sortedWeeks.length === 0) {
    // No games found — return empty payload
    return buildEmptyPayload(prefix);
  }

  // Use the most recent week as the "current" tournament
  // (The frontend uses chip-selection for multi-tournament; this adapter
  //  returns the most recent week's data by default. For multi-week support
  //  the caller can pass ?weekKey= — future enhancement.)
  const weekKey = sortedWeeks[sortedWeeks.length - 1];
  const weekGames = byWeek.get(weekKey);

  const location = dominantLocation(weekGames);
  const firstDate = weekGames[0]?.game_date || null;
  const lastDate  = weekGames[weekGames.length - 1]?.game_date || firstDate;

  // Normalize each game into the standard shape
  const now = new Date();
  const normalizedGames = weekGames.map((g) => {
    const home = g.home_team;
    const away = g.away_team;
    const isHome = isCDATeam(home);
    const opponent = isHome ? away : home;

    const usScore   = isHome ? g.home_score : g.away_score;
    const themScore = isHome ? g.away_score : g.home_score;

    const hasScores =
      usScore !== null && usScore !== undefined && usScore !== "" &&
      themScore !== null && themScore !== undefined && themScore !== "" &&
      !isNaN(Number(usScore)) && !isNaN(Number(themScore));

    const us   = hasScores ? Number(usScore)   : null;
    const them = hasScores ? Number(themScore) : null;

    let gameTime = null;
    if (g.game_date) {
      try {
        const d = new Date(g.game_date);
        if (!isNaN(d.getTime())) gameTime = d.toISOString();
      } catch {}
    }

    const done = hasScores || (gameTime ? new Date(gameTime) < now : false);

    let result = null;
    if (hasScores) result = us > them ? "W" : "L";

    const sets = hasScores ? [{ us, them }] : [];
    const score = hasScores ? `${us}–${them}` : null;

    return {
      id:       String(g.game_id),
      opponent: opponent || "Unknown",
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
    scrapedAt:            new Date().toISOString(),
    remoteTimestamp:      new Date().toISOString(),
    cached:               false,
    _dataSource:          "niwp",
    _teamPrefix:          prefix,
    _weekKey:             weekKey,
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

function deriveStandings(games, teamName, teamId) {
  const map = new Map();
  const ensure = (name, isUs) => {
    if (!map.has(name)) {
      map.set(name, {
        teamId:      isUs ? teamId : name.toLowerCase().replace(/\s+/g, "-"),
        teamName:    name,
        isUs,
        rank:        null,
        matchesWon:  0,
        matchesLost: 0,
        goalDiff:    0,
        setPercent:  0,
        earnedBid:   false,
        bidAlias:    null,
      });
    }
    return map.get(name);
  };

  for (const g of games) {
    if (!g.done || !g.result) continue;
    const us   = ensure(teamName, true);
    const them = ensure(g.opponent, false);
    if (g.result === "W") { us.matchesWon++;   them.matchesLost++; }
    else                  { us.matchesLost++;  them.matchesWon++;  }
    for (const s of g.sets || []) {
      us.goalDiff   += (s.us   || 0) - (s.them || 0);
      them.goalDiff += (s.them || 0) - (s.us   || 0);
    }
  }

  const rows = Array.from(map.values()).sort((a, b) => {
    if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
    return b.goalDiff - a.goalDiff;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// ─── API route handler ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const teamPrefix = String(req.query?.team || "B").toUpperCase();
  const force      = req.query?.force === "1";
  const now        = Date.now();
  const entry      = cacheMap.get(teamPrefix);

  if (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.status(200).json({ ...entry.payload, cached: true });
    return;
  }

  try {
    const payload = await fetchFromNIWP(teamPrefix);
    cacheMap.set(teamPrefix, { payload, fetchedAt: now });
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
