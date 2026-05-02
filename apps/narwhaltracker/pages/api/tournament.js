// NarWatch tournament API.
//
// DATA SOURCE PRIORITY:
//   1. Google Sheets (live)  — if GOOGLE_SHEETS_ID env var is set, all
//      traffic is delegated to /api/sheets.js. The sheet is authoritative
//      and the frontend receives the same JSON shape either way.
//   2. Static data           — falls back to lib/tournamentData.js (the
//      v1 default) when GOOGLE_SHEETS_ID is not configured.
//
// This design lets a team parent enable live data for a specific tournament
// by simply setting two env vars — no frontend changes required.

import { findTournament, computeGoalDiff, TOURNAMENTS } from "../../lib/tournamentData.js";

const CACHE_TTL_MS = 2 * 60 * 1000;
const cacheByKey = new Map();

function buildPayload(tournament) {
  const games    = tournament.games  || [];
  const record   = tournament.record || { wins: 0, losses: 0 };
  const goalDiff = tournament.goalDiff != null
    ? tournament.goalDiff
    : computeGoalDiff(games);

  return {
    teamName:     tournament.teamName,
    teamId:       tournament.teamId,
    tournamentId: tournament.id,
    event: {
      id:        tournament.id,
      name:      tournament.label,
      location:  tournament.venue?.name || null,
      startDate: null,
      endDate:   null,
      isOver:    false,
    },
    record,
    goalDiff,
    games,
    standings:            tournament.standings || [],
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

  // ── Live Sheets branch ──────────────────────────────────────────────────
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

  if (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    res.status(200).json({ ...entry.payload, cached: true });
    return;
  }

  const payload = buildPayload(tournament);
  cacheByKey.set(cacheKey, { payload, fetchedAt: now });
  res.status(200).json(payload);
}
