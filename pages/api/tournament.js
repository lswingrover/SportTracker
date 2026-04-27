const AES_BASE = "https://results.advancedeventsystems.com";

const EVENT_ID = process.env.EVENT_ID || "PTAwMDAwNDI2MDU90";
const DIVISION_ID = process.env.DIVISION_ID || "203854";
const TEAM_ID = process.env.TEAM_ID || "201772";
const TEAM_NAME = process.env.TEAM_NAME || "208 U14 Red";

const CACHE_TTL_MS = 2 * 60 * 1000;

let cache = {
  payload: null,
  fetchedAt: 0,
  remoteTimestamp: null,
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`AES ${res.status} for ${url}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

function parseTime(value) {
  if (!value) return { iso: null, ms: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { iso: null, ms: null };
  return { iso: d.toISOString(), ms: d.getTime() };
}

function setsFromMatch(m) {
  const setKeys = ["Sets", "MatchSets", "Games", "GameResults"];
  for (const k of setKeys) {
    if (Array.isArray(m?.[k])) return m[k];
  }
  return [];
}

function teamWonMatch(m) {
  const ours = pickFirst(m, ["TeamSetsWon", "OurSetsWon", "HomeTeamSetsWon"]);
  const theirs = pickFirst(m, ["OpponentSetsWon", "AwaySetsWon", "AwayTeamSetsWon"]);
  if (typeof ours === "number" && typeof theirs === "number") {
    return ours > theirs;
  }
  if (typeof m?.IsWin === "boolean") return m.IsWin;
  if (typeof m?.Winner === "string") {
    return m.Winner.toLowerCase().includes("us") || m.Winner === "Home";
  }
  return null;
}

function scoreString(m) {
  const sets = setsFromMatch(m);
  if (!sets.length) return null;
  const parts = sets
    .map((s) => {
      const us = pickFirst(s, ["TeamScore", "OurScore", "HomeScore", "Team1Score"]);
      const them = pickFirst(s, ["OpponentScore", "AwayScore", "Team2Score"]);
      if (us == null || them == null) return null;
      return `${us}-${them}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function normalizeMatch(m, { done }) {
  const start = pickFirst(m, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "MatchStartDateTime",
    "ScheduledStart",
    "StartTime",
  ]);
  const { iso, ms } = parseTime(start);
  const opponent =
    pickFirst(m, ["OpponentTeamName", "OpponentName", "AwayTeamName"]) ||
    pickFirst(m?.OpponentTeam || {}, ["TeamName", "Name"]) ||
    "TBD";
  const court =
    pickFirst(m, ["Court", "CourtName", "CourtText", "Location"]) ||
    pickFirst(m?.CourtInfo || {}, ["Name", "CourtName"]) ||
    "TBD";

  let result = null;
  let score = null;
  if (done) {
    const won = teamWonMatch(m);
    if (won === true) result = "W";
    else if (won === false) result = "L";
    score = scoreString(m);
  }

  return {
    id:
      pickFirst(m, ["MatchId", "Id", "ScheduleId"]) ||
      `${start || "x"}-${opponent}`,
    done,
    result,
    score,
    court,
    opponent,
    time: iso ? formatLocalTime(iso) : null,
    timeISO: iso,
    timeMs: ms,
    raw: undefined,
  };
}

function formatLocalTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function normalizeWork(w) {
  const start = pickFirst(w, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "WorkStartDateTime",
  ]);
  const { iso } = parseTime(start);
  return {
    id: pickFirst(w, ["MatchId", "WorkAssignmentId", "Id"]) || `${start || "x"}-work`,
    role:
      pickFirst(w, ["WorkRole", "Role", "Assignment", "Position"]) || "Work duty",
    court:
      pickFirst(w, ["Court", "CourtName", "CourtText"]) ||
      pickFirst(w?.CourtInfo || {}, ["Name", "CourtName"]) ||
      "TBD",
    timeISO: iso,
    time: iso ? formatLocalTime(iso) : null,
    teams:
      [
        pickFirst(w, ["HomeTeamName", "Team1Name"]),
        pickFirst(w, ["AwayTeamName", "Team2Name"]),
      ]
        .filter(Boolean)
        .join(" vs ") || null,
  };
}

function normalizeStandings(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    teamId: r.TeamId,
    teamName: r.TeamName,
    isUs: String(r.TeamId) === String(TEAM_ID),
    rank: r.OverallRank ?? r.FinishRank ?? null,
    rankText: r.FinishRankText ?? null,
    matchesWon: r.MatchesWon ?? 0,
    matchesLost: r.MatchesLost ?? 0,
    setsWon: r.SetsWon ?? 0,
    setsLost: r.SetsLost ?? 0,
    setPercent: r.SetPercent ?? 0,
    pointRatio: r.PointRatio ?? 0,
  }));
}

function recordFromStandings(standings) {
  const us = standings.find((s) => s.isUs);
  if (!us) return { wins: 0, losses: 0 };
  return { wins: us.matchesWon, losses: us.matchesLost };
}

function buildResponse({ team, current, future, work, standings, nextAssignments, remoteTimestamp }) {
  const playedRaw = Array.isArray(current) ? current : [];
  const upcomingRaw = Array.isArray(future) ? future : [];

  const played = playedRaw.map((m) => normalizeMatch(m, { done: true }));
  const upcoming = upcomingRaw.map((m) => normalizeMatch(m, { done: false }));

  const games = [...played, ...upcoming]
    .filter((g) => g.timeMs != null || g.timeISO != null)
    .sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));

  if (!games.length && (played.length || upcoming.length)) {
    games.push(...played, ...upcoming);
  }

  let firstUpcomingFlagged = false;
  for (const g of games) {
    if (!g.done && !firstUpcomingFlagged) {
      g.next = true;
      firstUpcomingFlagged = true;
    } else {
      g.next = false;
    }
    delete g.timeMs;
  }

  const standingsRows = normalizeStandings(standings?.value);
  const record = recordFromStandings(standingsRows);

  const us = standingsRows.find((s) => s.isUs);
  const poolPosition = us
    ? us.rankText || (us.rank ? String(us.rank) : null)
    : null;

  const workAssignments = (Array.isArray(work) ? work : []).map(normalizeWork);

  const nextGameObj = games.find((g) => !g.done && g.timeISO);
  let nextGame = null;
  if (nextGameObj) {
    const ms = new Date(nextGameObj.timeISO).getTime();
    const minutesUntil = Math.max(0, Math.round((ms - Date.now()) / 60000));
    nextGame = {
      time: nextGameObj.time,
      timeISO: nextGameObj.timeISO,
      court: nextGameObj.court,
      opponent: nextGameObj.opponent,
      minutesUntil,
    };
  }

  let projectedDone = null;
  const lastWithTime = [...games].reverse().find((g) => g.timeISO);
  if (lastWithTime) {
    const ms = new Date(lastWithTime.timeISO).getTime() + 75 * 60 * 1000;
    projectedDone = new Date(ms).toISOString();
  }

  return {
    teamName: team?.TeamName || TEAM_NAME,
    teamId: TEAM_ID,
    eventId: EVENT_ID,
    divisionId: DIVISION_ID,
    record,
    poolPosition,
    nextGame,
    projectedDone,
    games,
    standings: standingsRows,
    workAssignments,
    nextAssignmentsCount: Array.isArray(nextAssignments?.value)
      ? nextAssignments.value.length
      : 0,
    scrapedAt: new Date().toISOString(),
    remoteTimestamp,
    cached: false,
  };
}

async function loadFresh() {
  const urls = {
    team: `${AES_BASE}/api/event/${EVENT_ID}/teams/${TEAM_ID}`,
    current: `${AES_BASE}/api/event/${EVENT_ID}/division/${DIVISION_ID}/team/${TEAM_ID}/schedule/current`,
    future: `${AES_BASE}/api/event/${EVENT_ID}/division/${DIVISION_ID}/team/${TEAM_ID}/schedule/future`,
    work: `${AES_BASE}/api/event/${EVENT_ID}/division/${DIVISION_ID}/team/${TEAM_ID}/schedule/work`,
    standings: `${AES_BASE}/odata/${EVENT_ID}/standings(dId=${DIVISION_ID},cId=null,tIds=[])`,
    nextAssignments: `${AES_BASE}/odata/${EVENT_ID}/nextassignments(dId=${DIVISION_ID},cId=null,tIds=[])`,
    timestamp: `${AES_BASE}/api/event/${EVENT_ID}/timestamp`,
  };

  const [team, current, future, work, standings, nextAssignments, timestamp] =
    await Promise.all([
      fetchJson(urls.team).catch(() => null),
      fetchJson(urls.current).catch(() => []),
      fetchJson(urls.future).catch(() => []),
      fetchJson(urls.work).catch(() => []),
      fetchJson(urls.standings).catch(() => ({ value: [] })),
      fetchJson(urls.nextAssignments).catch(() => ({ value: [] })),
      fetchJson(urls.timestamp).catch(() => null),
    ]);

  const remoteTimestamp = timestamp?.LastUpdatedTimestamp || null;
  const payload = buildResponse({
    team,
    current,
    future,
    work,
    standings,
    nextAssignments,
    remoteTimestamp,
  });
  return { payload, remoteTimestamp };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const force = req.query?.force === "1";
  const now = Date.now();
  const cacheFresh = now - cache.fetchedAt < CACHE_TTL_MS && cache.payload;

  try {
    if (!force && cacheFresh) {
      const ts = await fetchJson(`${AES_BASE}/api/event/${EVENT_ID}/timestamp`).catch(
        () => null
      );
      const remote = ts?.LastUpdatedTimestamp || null;
      if (remote && cache.remoteTimestamp && remote === cache.remoteTimestamp) {
        res.status(200).json({ ...cache.payload, cached: true });
        return;
      }
    }

    const { payload, remoteTimestamp } = await loadFresh();
    cache = { payload, fetchedAt: now, remoteTimestamp };
    res.status(200).json(payload);
  } catch (err) {
    if (cache.payload) {
      res.status(200).json({
        ...cache.payload,
        cached: true,
        staleError: String(err?.message || err),
      });
      return;
    }
    res.status(502).json({ error: String(err?.message || err) });
  }
}
