// NarWatch tournament API.
//
// DATA SOURCE PRIORITY:
//   1. 6-8 Sports (auto or explicit) — USAWP Junior Olympics live scores.
//      Auto-activates when live or today-scheduled Narwhal JO games are
//      detected (no env var required). Probe is cached (2 min positive /
//      10 min negative) — zero overhead outside JO season.
//      Override on:  SIXEIGHT_ENABLED=true  (skip probe, always use 6-8)
//      Override off: SIXEIGHT_DISABLED=true (skip probe, never use 6-8)
//   2. NIWP WordPress API (live)  — if NIWP_API_ENABLED=true.
//      Primary live source for North Idaho Water Polo club tournaments.
//      No auth required. NIWP_TEAM_PREFIX=B|G|BJV|GJV (default: B).
//   3. TorMatch (live)            — if TORMATCH_TOURNAMENT_ID is set.
//   4. SportsEngine Tourney       — if SPORTSENGINE_TOURNAMENT_ID is set.
//      HTML-scrapes tourneymachine.com. Discovery: Google
//      `site:tourneymachine.com "Tournament Name"` → IDTournament= param.
//   5. Google Sheets (live)       — if GOOGLE_SHEETS_ID is set.
//   6. Static data                — falls back to lib/tournamentData.js.
//
// Only the 6-8 Sports probe runs automatically. All other sources require
// an explicit env var set in the narwatch Vercel project.

import { findTournament, computeGoalDiff, TOURNAMENTS } from "../../lib/tournamentData.js";

const CACHE_TTL_MS = 2 * 60 * 1000;
const cacheByKey = new Map();

// Derive the next upcoming game from a static games array.
// Returns a nextEvent-shaped object or null.
function computeNextEventFromGames(games) {
  if (!Array.isArray(games) || games.length === 0) return null;
  const now = Date.now();
  const upcoming = games
    .filter((g) => !g.done && g.timeISO && new Date(g.timeISO).getTime() > now)
    .sort((a, b) => new Date(a.timeISO).getTime() - new Date(b.timeISO).getTime());
  if (!upcoming.length) return null;
  const g = upcoming[0];
  return {
    kind:     "game",
    id:       g.id,
    opponent: g.isBracket ? "TBD (bracket)" : g.opponent,
    court:    g.court || null,
    time:     g.time  || null,
    timeISO:  g.timeISO,
  };
}

function buildPayload(tournament) {
  const games    = tournament.games  || [];
  const allDone  = games.length > 0 && games.every((g) => g.done);
  const record   = tournament.record || { wins: 0, losses: 0 };
  const goalDiff = tournament.goalDiff != null
    ? tournament.goalDiff
    : computeGoalDiff(games);
  const nextEvent = computeNextEventFromGames(games);
  const firstGame = games.find((g) => g.timeISO);

  return {
    teamName:     tournament.teamName,
    teamId:       tournament.teamId,
    tournamentId: tournament.id,
    event: {
      id:        tournament.id,
      name:      tournament.label,
      location:  tournament.venue?.name || null,
      startDate: firstGame?.timeISO || null,
      endDate:   null,
      isOver:    allDone,
    },
    record,
    goalDiff,
    games,
    standings:            tournament.standings || [],
    teams:                [],
    nextGame:             nextEvent,
    nextEvent:            nextEvent,
    liveGame:             null,
    isOver:               allDone,
    isLive:               false,
    _isStaticPayload:     true,
    _pollSchedule:        { intervalMs: allDone ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000 },
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
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // ── 6-8 Sports branch (USAWP Junior Olympics) ───────────────────────────
  // Explicit enable: always use 6-8 (useful for testing / forcing).
  // Explicit disable: skip probe entirely (SIXEIGHT_DISABLED=true).
  // Auto (neither set): probe for live or today-scheduled Narwhal JO games.
  //   Positive probe → route here. Negative probe → fall through to NIWP.
  //   Probe TTL: 2 min when active, 10 min when inactive.
  if (process.env.SIXEIGHT_ENABLED === "true") {
    const { default: sixeightHandler } = await import('./sixeight.js');
    return sixeightHandler(req, res);
  }
  if (process.env.SIXEIGHT_DISABLED !== "true") {
    const { probeNarwhalsGames } = await import('./sixeight.js');
    const teamName = process.env.SIXEIGHT_TEAM_NAME || "Narwhal";
    const probe = await probeNarwhalsGames(teamName);
    if (probe?.hasActiveGames) {
      const { default: sixeightHandler } = await import('./sixeight.js');
      return sixeightHandler(req, res);
    }
  }

  // ── NIWP WordPress API branch ───────────────────────────────────────────
  // When NIWP_API_ENABLED=true, delegate to niwp.js. This is the primary
  // live source for North Idaho Water Polo data.
  // Pass ?team= or use NIWP_TEAM_PREFIX env var to filter by squad.
  if (process.env.NIWP_API_ENABLED === "true") {
    // Forward ?team= from caller, or fall back to env var, or default "B"
    if (!req.query.team && process.env.NIWP_TEAM_PREFIX) {
      req = { ...req, query: { ...req.query, team: process.env.NIWP_TEAM_PREFIX } };
    }
    const { default: niwpHandler } = await import("./niwp.js");
    return niwpHandler(req, res);
  }

  // -- TorMatch live branch -----------------------------------------------
  // When TORMATCH_TOURNAMENT_ID is set, delegate to tormatch.js.
  if (process.env.TORMATCH_TOURNAMENT_ID) {
    const { default: tormatchHandler } = await import('./tormatch.js');
    return tormatchHandler(req, res);
  }

  // ── SportsEngine TourneyMachine branch ──────────────────────────────────
  // Set SPORTSENGINE_TOURNAMENT_ID to the tourneymachine.com hash ID.
  // SPORTSENGINE_TEAM_NAME defaults to "Narwhal".
  // Discover the ID: Google `site:tourneymachine.com "Tournament Name"`.
  if (process.env.SPORTSENGINE_TOURNAMENT_ID) {
    const { default: sportsengineHandler } = await import('./sportsengine.js');
    return sportsengineHandler(req, res);
  }

  // -- Live Sheets branch ──────────────────────────────────────────────────
  // When GOOGLE_SHEETS_ID is set, hand off entirely to sheets.js.
  // The returned JSON shape is identical, so the frontend is unaffected.
  if (process.env.GOOGLE_SHEETS_ID) {
    const { default: sheetsHandler } = await import("./sheets.js");
    return sheetsHandler(req, res);
  }

  // ── Static branch ───────────────────────────────────────────────────────
  const tournamentId = String(
    req.query?.tournamentId || req.query?.eventId || TOURNAMENTS[0]?.id || ""
  );
  const tournament = findTournament(tournamentId) || TOURNAMENTS[0];

  if (!tournament) {
    res.status(404).json({ error: "tournament_not_found", tournamentId });
    return;
  }

  const cacheKey = tournament.id;
  const force    = req.query?.force === "1";
  const now      = Date.now();
  const entry    = cacheByKey.get(cacheKey);

  const payload = (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS)
    ? { ...entry.payload, cached: true }
    : buildPayload(tournament);

  if (!entry || force || now - entry.fetchedAt >= CACHE_TTL_MS) {
    cacheByKey.set(cacheKey, { payload, fetchedAt: now });
  }

  // Completed tournaments are immutable — tell the edge to hold them for a day.
  // In-progress static tournaments: 5 min fresh, 30 min stale-while-revalidate.
  const cacheHeader = payload.isOver
    ? "public, max-age=86400, stale-while-revalidate=604800"
    : "public, max-age=300, stale-while-revalidate=1800";
  res.setHeader("Cache-Control", cacheHeader);
  res.status(200).json(payload);
}
