// Narwhal Tracker tournament API.
// v1 reads from a static lib (lib/tournamentData.js). Future versions can
// add a live data branch — the response shape mirrors what the AES-backed
// client expected so the UI components didn't need rework.

import { findTournament, computeGoalDiff, TOURNAMENTS } from "../../lib/tournamentData.js";

const CACHE_TTL_MS = 2 * 60 * 1000;
const cacheByKey = new Map();

function buildPayload(tournament) {
  const games = tournament.games || [];
  const record = tournament.record || { wins: 0, losses: 0 };
  const goalDiff = tournament.goalDiff != null ? tournament.goalDiff : computeGoalDiff(games);
  return {
    teamName: tournament.teamName,
    teamId: tournament.teamId,
    tournamentId: tournament.id,
    event: {
      id: tournament.id,
      name: tournament.label,
      location: tournament.venue?.name || null,
      startDate: null,
      endDate: null,
      isOver: false,
    },
    record,
    goalDiff,
    games,
    standings: tournament.standings || [],
    teams: [],
    nextGame: null,
    nextEvent: null,
    liveGame: null,
    isOver: false,
    isLive: false,
    pool: null,
    brackets: [],
    workAssignments: [],
    teamWatchNowLink: null,
    projectedDone: null,
    projectedDoneSource: null,
    nextAssignmentsCount: 0,
    scrapedAt: new Date().toISOString(),
    remoteTimestamp: null,
    cached: false,
  };
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const tournamentId = String(
    req.query?.tournamentId || req.query?.eventId || TOURNAMENTS[0]?.id || ""
  );
  const tournament = findTournament(tournamentId) || TOURNAMENTS[0];

  if (!tournament) {
    res.status(404).json({ error: "tournament_not_found", tournamentId });
    return;
  }

  const cacheKey = tournament.id;
  const force = req.query?.force === "1";
  const now = Date.now();
  const entry = cacheByKey.get(cacheKey);
  if (!force && entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    res.status(200).json({ ...entry.payload, cached: true });
    return;
  }

  const payload = buildPayload(tournament);
  cacheByKey.set(cacheKey, { payload, fetchedAt: now });
  res.status(200).json(payload);
}
