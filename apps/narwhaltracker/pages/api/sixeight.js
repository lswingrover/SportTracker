// NarWatch: 6-8 Sports API adapter for USAWP Junior Olympics live scores.
//
// ENDPOINTS CONSUMED:
//   GET /v2/leagues/links/                            → active JO league list
//   GET /v2/leagues/{leagueId}/games/?limit=100&offset=N  → paginated games
//   GET /v2/leagues/{leagueId}/teams/                 → team standings
//
// OUTPUT: same JSON shape as tormatch.js / niwp.js so the frontend is
// unaffected. Also includes _pollSchedule for adaptive client polling.

import { computePollSchedule } from "../../lib/pollSchedule.js";

const SIXEIGHT_BASE = "https://api.6-8sports.com/api";
const LIVE_TTL_MS  = 30 * 1000;        // 30 s when a live game is detected
const IDLE_TTL_MS  = 5 * 60 * 1000;   // 5 min otherwise

// Module-level cache (main handler)
let _cache     = null;
let _fetchedAt = 0;
let _cacheKey  = "";

// Probe cache (auto-detection — separate TTLs from main handler)
const PROBE_ACTIVE_TTL_MS   = 2  * 60 * 1000;  // 2 min when JO games active today
const PROBE_INACTIVE_TTL_MS = 10 * 60 * 1000;  // 10 min when no JO games today
let _probeCache     = null;   // { hasActiveGames: bool, leagueId: string } | null
let _probeFetchedAt = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${SIXEIGHT_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`6-8sports API ${path} → ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLeague(leagueIdHint) {
  if (leagueIdHint) return String(leagueIdHint);
  const links = await apiFetch("/v2/leagues/links/");
  const list = Array.isArray(links) ? links : (links.results || links.data || []);
  const match = list.find((l) => {
    const name = (l.name || "").toLowerCase();
    return name.includes("junior") || name.includes("jo") || name.includes("olympic");
  });
  if (!match) throw new Error("6-8sports: could not auto-discover a JO league from /v2/leagues/links/");
  return String(match.pk);
}

async function fetchAllGames(leagueId) {
  const results = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const page = await apiFetch(`/v2/leagues/${leagueId}/games/?limit=${limit}&offset=${offset}`);
    const items = page.results || page.data || (Array.isArray(page) ? page : []);
    results.push(...items);
    if (!page.next || items.length < limit) break;
    offset += limit;
  }
  return results;
}

function isPastScheduledTime(raw) {
  if (!raw.schedule_date || !raw.schedule_time) return false;
  try {
    const dt = new Date(`${raw.schedule_date}T${raw.schedule_time}Z`);
    return !isNaN(dt.getTime()) && dt.getTime() < Date.now();
  } catch {
    return false;
  }
}

function normalizeGame(raw, narwhalsFragment) {
  const frag = (narwhalsFragment || "narwhal").toLowerCase();
  const darkName  = (raw.dark_team_name  || "").trim();
  const lightName = (raw.light_team_name || "").trim();
  const darkIsUs  = darkName.toLowerCase().includes(frag);
  const lightIsUs = lightName.toLowerCase().includes(frag);
  const isNarwhalsGame = darkIsUs || lightIsUs;

  const ourScore   = darkIsUs  ? (raw.dark_team_score  ?? null)
                   : lightIsUs ? (raw.light_team_score ?? null)
                   : null;
  const theirScore = darkIsUs  ? (raw.light_team_score ?? null)
                   : lightIsUs ? (raw.dark_team_score  ?? null)
                   : null;
  const opponent   = darkIsUs  ? lightName
                   : lightIsUs ? darkName
                   : (lightName || darkName || "Unknown");

  let timeISO = null;
  if (raw.schedule_date && raw.schedule_time) {
    try {
      const dt = new Date(`${raw.schedule_date}T${raw.schedule_time}Z`);
      if (!isNaN(dt.getTime())) timeISO = dt.toISOString();
    } catch {}
  }

  const done = !raw.in_progress
    && (
      (raw.dark_team_score  != null && raw.dark_team_score  > 0)
      || (raw.light_team_score != null && raw.light_team_score > 0)
      || isPastScheduledTime(raw)
    );

  let result = null;
  if (done && ourScore !== null && theirScore !== null) {
    result = ourScore > theirScore ? "W" : ourScore < theirScore ? "L" : "T";
  }

  const sets = (ourScore !== null || theirScore !== null)
    ? [{ us: ourScore ?? 0, them: theirScore ?? 0 }]
    : [];

  // Derive round label from raw.name
  let round = null;
  if (raw.name) {
    const n = raw.name.trim();
    const lower = n.toLowerCase();
    if      (lower.includes("pool play"))    round = "Pool";
    else if (lower.includes("quarterfinal")) round = "QF";
    else if (lower.includes("semifinal"))    round = "SF";
    else if (lower === "final")              round = "Final";
    else {
      const gameNum = n.match(/^game\s+(\d+)$/i);
      round = gameNum ? `G${gameNum[1]}` : n;
    }
  }

  return {
    id:               String(raw.pk || ""),
    opponent:         opponent || "Unknown",
    timeISO,
    court:            null,
    done,
    result,
    sets,
    round,
    notes:            null,
    _isNarwhalsGame:  isNarwhalsGame,
  };
}

function normalizeStanding(raw, narwhalsFragment) {
  const frag = (narwhalsFragment || "narwhal").toLowerCase();
  const name = raw.name || "";
  return {
    teamId:       String(raw.pk || ""),
    teamName:     name,
    isUs:         name.toLowerCase().includes(frag),
    rank:         null,
    matchesWon:   raw.wins   ?? 0,
    matchesLost:  raw.losses ?? 0,
    goalDiff:     (raw.goals_for ?? 0) - (raw.goals_against ?? 0),
  };
}

// ─── Auto-detection probe ─────────────────────────────────────────────────────

/**
 * Probe the 6-8 Sports API for active Narwhal JO games without committing to a
 * full response. "Active" means: any Narwhal game is in_progress, OR any Narwhal
 * game is scheduled for today (UTC). Returns null on any error so the caller can
 * fall through to the next data source.
 *
 * Negative result (no active JO): cached 10 min — nearly zero overhead outside
 * JO season. Positive result (JO day): cached 2 min for fast live updates.
 *
 * Called by tournament.js before the NIWP branch. When this returns
 * { hasActiveGames: true }, tournament.js delegates to the full sixeight handler
 * instead of NIWP.
 *
 * @param {string} [teamName] - Fragment to identify Narwhal team entries.
 * @returns {Promise<{ hasActiveGames: boolean, leagueId: string } | null>}
 */
export async function probeNarwhalsGames(teamName = "Narwhal") {
  const now = Date.now();
  const ttl = _probeCache?.hasActiveGames
    ? PROBE_ACTIVE_TTL_MS
    : PROBE_INACTIVE_TTL_MS;

  if (_probeCache !== null && now - _probeFetchedAt < ttl) {
    return _probeCache;
  }

  try {
    const leagueId  = await discoverLeague(process.env.SIXEIGHT_LEAGUE_ID || "");
    const rawGames  = await fetchAllGames(leagueId);
    const frag      = (teamName || "narwhal").toLowerCase();
    const todayUTC  = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    const narwhalsGames = rawGames.filter((g) =>
      (g.dark_team_name  || "").toLowerCase().includes(frag) ||
      (g.light_team_name || "").toLowerCase().includes(frag)
    );

    const hasActiveGames = narwhalsGames.some((g) =>
      g.in_progress ||
      (g.schedule_date && String(g.schedule_date).startsWith(todayUTC))
    );

    _probeCache     = { hasActiveGames, leagueId };
    _probeFetchedAt = now;
    console.log(
      `[sixeight probe] leagueId=${leagueId} narwhalsGames=${narwhalsGames.length} hasActiveGames=${hasActiveGames}`
    );
    return _probeCache;
  } catch (err) {
    console.warn("[sixeight probe] skipped:", err.message);
    return null; // don't cache errors — let next request retry
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const leagueIdHint  = req.query.leagueId  || process.env.SIXEIGHT_LEAGUE_ID  || "";
  const teamName      = req.query.teamName   || process.env.SIXEIGHT_TEAM_NAME  || "Narwhal";
  const force         = req.query.force === "1";
  const now           = Date.now();

  // We don't know the leagueId until discovery, so cache key starts without it;
  // it gets updated below once we know the leagueId.
  const prelimCacheKey = `${leagueIdHint}|${teamName}`;

  if (!force && _cache && _cacheKey.endsWith(`|${teamName}`) && now - _fetchedAt < (_cache._liveDetected ? LIVE_TTL_MS : IDLE_TTL_MS)) {
    res.setHeader("Cache-Control", "public, max-age=20, stale-while-revalidate=60");
    return res.status(200).json({ ..._cache, cached: true });
  }

  try {
    const leagueId = await discoverLeague(leagueIdHint);
    const cacheKey = `${leagueId}|${teamName}`;

    // Check cache again with the resolved leagueId
    if (!force && _cache && _cacheKey === cacheKey && now - _fetchedAt < (_cache._liveDetected ? LIVE_TTL_MS : IDLE_TTL_MS)) {
      res.setHeader("Cache-Control", "public, max-age=20, stale-while-revalidate=60");
      return res.status(200).json({ ..._cache, cached: true });
    }

    // Fetch games and teams in parallel
    const [rawGames, rawTeams] = await Promise.all([
      fetchAllGames(leagueId),
      apiFetch(`/v2/leagues/${leagueId}/teams/`).then((r) =>
        Array.isArray(r) ? r : (r.results || r.data || [])
      ),
    ]);

    const frag = teamName.toLowerCase();

    // Detect live before normalization
    const isLiveDetected = rawGames.some((g) => g.in_progress);

    // Normalize
    const games     = rawGames.map((g) => normalizeGame(g, frag));
    const standings = rawTeams.map((t) => normalizeStanding(t, frag));

    // Our team entry
    const ourStanding = standings.find((s) => s.isUs) || null;
    const teamId      = ourStanding?.teamId || "";

    // Record & goal diff from done Narwhals games
    const ourGames  = games.filter((g) => g._isNarwhalsGame);
    const doneGames = ourGames.filter((g) => g.done);
    const wins      = doneGames.filter((g) => g.result === "W").length;
    const losses    = doneGames.filter((g) => g.result === "L").length;
    const goalDiff  = doneGames.reduce((acc, g) => {
      const s = g.sets[0];
      return acc + (s ? s.us - s.them : 0);
    }, 0);

    // Next and live game (Narwhals only)
    const upcoming  = ourGames
      .filter((g) => !g.done && g.timeISO)
      .sort((a, b) => new Date(a.timeISO) - new Date(b.timeISO));
    const nextGame  = upcoming[0] || null;
    const liveGame  = ourGames.find((g) => !g.done && g.sets.length > 0) || null;
    const isLive    = !!liveGame || isLiveDetected;

    const isOver    = ourGames.length > 0 && ourGames.every((g) => g.done);

    const pollSchedule = computePollSchedule(games);

    const payload = {
      teamName:             teamName,
      teamId:               teamId,
      tournamentId:         leagueId,
      event: {
        id:        leagueId,
        name:      `6-8 Sports League ${leagueId}`,
        location:  null,
        startDate: null,
        endDate:   null,
        isOver,
      },
      record:               { wins, losses },
      goalDiff,
      games,
      standings,
      teams:                [],
      nextGame,
      liveGame,
      isOver,
      isLive,
      pool:                 null,
      brackets:             [],
      workAssignments:      [],
      teamWatchNowLink:     null,
      projectedDone:        null,
      projectedDoneSource:  null,
      nextAssignmentsCount: 0,
      scrapedAt:            new Date().toISOString(),
      remoteTimestamp:      null,
      cached:               false,
      _dataSource:          "6-8sports",
      _leagueId:            leagueId,
      _liveDetected:        isLiveDetected,
      _pollSchedule:        pollSchedule,
    };

    _cache     = payload;
    _fetchedAt = now;
    _cacheKey  = cacheKey;

    res.setHeader("Cache-Control", "public, max-age=20, stale-while-revalidate=60");
    return res.status(200).json(payload);

  } catch (err) {
    console.error("[sixeight] fetch error:", err.message);
    if (_cache) {
      return res.status(200).json({ ..._cache, cached: true, _stale: true, _staleError: String(err.message) });
    }
    return res.status(502).json({ error: "sixeight_fetch_failed", detail: String(err.message) });
  }
}
