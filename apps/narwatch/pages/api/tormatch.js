// NarWatch: TorMatch live data adapter
// Polls live.tormatch.com + scheduling.tormatch.com and normalizes to NarWatch payload shape.

const LIVE_API  = "https://live.tormatch.com";
const SCHED_API = "https://scheduling.tormatch.com";
const CACHE_TTL_MS = 60 * 1000;

let _cache = null;
let _cachedAt = 0;
let _cacheKey = "";

function getApiKey() {
  return process.env.TORMATCH_API_KEY || "ZbD09T1jkeF6aSD3719xnJAsoa83iSIFA";
}

async function fetchLive(path) {
  const res = await fetch(`${LIVE_API}${path}`, {
    headers: { Authorization: getApiKey() },
  });
  if (!res.ok) throw new Error(`Live API ${path} → ${res.status}`);
  return res.json();
}

async function fetchSched(path) {
  const res = await fetch(`${SCHED_API}${path}`, {
    headers: { Authentication: getApiKey() },
  });
  if (!res.ok) throw new Error(`Sched API ${path} → ${res.status}`);
  return res.json();
}

function isOurTeam(teamName, ourTeamName) {
  if (!teamName) return false;
  const name = teamName.toLowerCase();
  const target = (ourTeamName || "narwhals").toLowerCase();
  return name.includes(target) || name.includes("narwhal");
}

function normalizeMatch(match, ourTeamName, teamsById) {
  if (!match) return null;

  const homeTeam = teamsById?.[match.home_team_id] || {};
  const awayTeam = teamsById?.[match.away_team_id] || {};
  const homeIsUs = isOurTeam(homeTeam.name, ourTeamName);
  const awayIsUs = isOurTeam(awayTeam.name, ourTeamName);

  if (!homeIsUs && !awayIsUs) return null;

  const opponent = homeIsUs ? (awayTeam.name || "Unknown") : (homeTeam.name || "Unknown");
  const ourScore  = homeIsUs ? (match.home_score ?? null) : (match.away_score ?? null);
  const theirScore = homeIsUs ? (match.away_score ?? null) : (match.home_score ?? null);

  const done = match.status === "completed" || match.status === "finished";
  let result = null;
  if (done && ourScore !== null && theirScore !== null) {
    result = ourScore > theirScore ? "W" : ourScore < theirScore ? "L" : "T";
  }

  const sets = (ourScore !== null && theirScore !== null)
    ? [{ us: ourScore, them: theirScore }]
    : [];

  const timeISO = match.scheduled_at || match.starts_at || match.date || null;
  const court = match.court || match.location || match.field || null;

  return {
    id: String(match.id || match.match_id || ""),
    opponent,
    timeISO,
    court,
    done,
    result,
    sets,
    round: match.round || match.stage_name || match.pool || null,
    notes: match.notes || null,
  };
}

function normalizeStandings(rankingsData, ourTeamName, teamsById) {
  if (!rankingsData) return [];
  const rows = Array.isArray(rankingsData)
    ? rankingsData
    : (rankingsData.rankings || rankingsData.items || []);

  return rows.map((r) => {
    const team = teamsById?.[r.team_id] || {};
    const name = r.team_name || team.name || r.name || "Unknown";
    return {
      teamName: name,
      isUs: isOurTeam(name, ourTeamName),
      rank: r.rank || r.position || null,
      wins: r.wins ?? r.w ?? 0,
      losses: r.losses ?? r.l ?? 0,
      goalDiff: r.goal_difference ?? r.goal_diff ?? r.gd ?? 0,
      points: r.points ?? null,
      goalsFor: r.goals_for ?? r.gf ?? null,
      goalsAgainst: r.goals_against ?? r.ga ?? null,
    };
  });
}

async function fetchFromTorMatch(tournamentId, ourTeamName) {
  const t = tournamentId;

  const [
    liveTournResult,
    schedTournResult,
    partsResult,
    matchesResult,
    stagesResult,
    teamsResult,
    rankingsResult,
  ] = await Promise.allSettled([
    fetchLive(`/v2/tournaments/${t}`),
    fetchSched(`/tournaments/${t}`),
    fetchSched(`/tournaments/${t}/parts`),
    fetchSched(`/tournaments/${t}/matches`),
    fetchSched(`/tournaments/${t}/stages?no_draft_rounds=true`),
    fetchSched(`/tournaments/${t}/teams`),
    fetchSched(`/tournaments/${t}/rankings`),
  ]);

  const liveTournament = liveTournResult.status === "fulfilled" ? liveTournResult.value : null;
  const schedTournament = schedTournResult.status === "fulfilled" ? schedTournResult.value : null;
  const parts = partsResult.status === "fulfilled" ? partsResult.value : null;
  const matchesRaw = matchesResult.status === "fulfilled" ? matchesResult.value : null;
  const stagesRaw = stagesResult.status === "fulfilled" ? stagesResult.value : null;
  const teamsRaw = teamsResult.status === "fulfilled" ? teamsResult.value : null;
  const rankingsRaw = rankingsResult.status === "fulfilled" ? rankingsResult.value : null;

  // Build team lookup map
  // API returns {data: {count, teams:[...]}} wrapper
  const teamsUnwrapped = teamsRaw?.data?.teams ?? teamsRaw;
  const teamsList = Array.isArray(teamsUnwrapped)
    ? teamsUnwrapped
    : (teamsUnwrapped?.teams || teamsUnwrapped?.items || []);
  const teamsById = {};
  for (const tm of teamsList) {
    const id = tm.id || tm.team_id;
    if (id) teamsById[id] = tm;
  }

  // Find our team
  const ourTeamObj = teamsList.find((tm) => isOurTeam(tm.name, ourTeamName)) || null;
  const ourTeamId = ourTeamObj?.id || ourTeamObj?.team_id || null;

  // Normalize matches
  const matchesList = Array.isArray(matchesRaw)
    ? matchesRaw
    : (matchesRaw?.matches || matchesRaw?.items || []);
  const games = matchesList
    .map((m) => normalizeMatch(m, ourTeamName, teamsById))
    .filter(Boolean);

  // Standings
  const standings = normalizeStandings(rankingsRaw, ourTeamName, teamsById);

  // Our record from games
  const doneGames = games.filter((g) => g.done);
  const wins = doneGames.filter((g) => g.result === "W").length;
  const losses = doneGames.filter((g) => g.result === "L").length;
  const record = `${wins}-${losses}`;

  // Goal diff
  const goalDiff = doneGames.reduce((acc, g) => {
    const s = g.sets[0];
    if (s) acc += (s.us - s.them);
    return acc;
  }, 0);

  // Next game
  const now = Date.now();
  const upcoming = games
    .filter((g) => !g.done && g.timeISO)
    .sort((a, b) => new Date(a.timeISO) - new Date(b.timeISO));
  const nextGame = upcoming[0] || null;

  // Live game — last updated less than 10 min ago and not done
  const liveGame = games.find((g) => !g.done && g.sets.length > 0) || null;
  const isLive = !!liveGame;

  // Tournament meta
  const tournName = liveTournament?.name || schedTournament?.name || `Tournament ${t}`;
  const isOver = liveTournament?.status === "completed"
    || schedTournament?.status === "completed"
    || (games.length > 0 && games.every((g) => g.done));

  // Pool detection from stages/parts
  const stagesList = Array.isArray(stagesRaw)
    ? stagesRaw
    : (stagesRaw?.stages || stagesRaw?.items || []);
  const pool = stagesList.length > 0 ? (stagesList[0]?.name || null) : null;

  // Build teams array for bracket display
  const teams = teamsList.map((tm) => ({
    teamId: String(tm.id || tm.team_id || ""),
    teamName: tm.name || "Unknown",
    seed: tm.seed || null,
  }));

  return {
    teamName: ourTeamObj?.name || ourTeamName,
    teamId: String(ourTeamId || ""),
    tournamentId: String(t),
    tournamentName: tournName,
    event: tournName,
    record,
    goalDiff,
    games,
    standings,
    teams,
    nextGame,
    liveGame,
    isOver: isOver || false,
    isLive,
    pool,
    brackets: stagesList,
    parts: Array.isArray(parts) ? parts : (parts?.parts || []),
    _dataSource: "tormatch",
    _fetchedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  const tournamentId =
    req.query.id ||
    process.env.TORMATCH_TOURNAMENT_ID ||
    "258";
  const ourTeamName =
    req.query.teamName ||
    process.env.TORMATCH_TEAM_NAME ||
    "Narwhals";

  const cacheKey = `${tournamentId}|${ourTeamName}`;
  const now = Date.now();

  if (_cache && _cacheKey === cacheKey && now - _cachedAt < CACHE_TTL_MS) {
    return res.status(200).json(_cache);
  }

  try {
    const data = await fetchFromTorMatch(tournamentId, ourTeamName);
    _cache = data;
    _cachedAt = now;
    _cacheKey = cacheKey;
    return res.status(200).json(data);
  } catch (err) {
    console.error("[tormatch] fetch error:", err.message);
    if (_cache && _cacheKey === cacheKey) {
      // stale-on-error
      return res.status(200).json({ ..._cache, _stale: true });
    }
    return res.status(502).json({ error: "TorMatch fetch failed", detail: err.message });
  }
}
