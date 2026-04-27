// Deferred for v3 (intentionally not implemented yet):
//   - Pool standings tab: render `/division/{div}/pools` so we can show
//     "Pool 3, 4th of 4" pool breakdown next to the overall standings.
//   - Venue directions + contact info: use event metadata location field
//     to render a venue card with Apple Maps + Google Maps deep links and
//     any contact info AES exposes.

const AES_BASE = "https://results.advancedeventsystems.com";

const DEFAULT_EVENT_ID = process.env.EVENT_ID || "PTAwMDAwNDI2MDU90";
const DEFAULT_DIVISION_ID = process.env.DIVISION_ID || "203854";
const DEFAULT_TEAM_ID = process.env.TEAM_ID || "201772";
const DEFAULT_TEAM_NAME = process.env.TEAM_NAME || "208 U14 Red";

const CACHE_TTL_MS = 2 * 60 * 1000;

const cacheByKey = new Map();

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`AES ${res.status} for ${url}`);
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
  for (const k of ["Sets", "MatchSets", "Games", "GameResults"]) {
    if (Array.isArray(m?.[k])) return m[k];
  }
  return [];
}

function setScores(s) {
  const us = pickFirst(s, ["TeamScore", "OurScore", "HomeScore", "Team1Score", "FirstTeamScore"]);
  const them = pickFirst(s, ["OpponentScore", "AwayScore", "Team2Score", "SecondTeamScore"]);
  return { us, them };
}

function isDecidingSet(s) {
  return s?.IsDecidingSet === true;
}

function teamWonMatch(m) {
  const ours = pickFirst(m, ["TeamSetsWon", "OurSetsWon", "HomeTeamSetsWon"]);
  const theirs = pickFirst(m, ["OpponentSetsWon", "AwaySetsWon", "AwayTeamSetsWon"]);
  if (typeof ours === "number" && typeof theirs === "number") return ours > theirs;
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
      const { us, them } = setScores(s);
      if (us == null || them == null) return null;
      return `${us}-${them}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function liveScoreShape(m, opponentName) {
  const sets = setsFromMatch(m);
  if (!sets.length) return null;
  const parsed = sets.map((s) => {
    const { us, them } = setScores(s);
    return {
      us: typeof us === "number" ? us : null,
      them: typeof them === "number" ? them : null,
      complete: typeof s?.IsComplete === "boolean" ? s.IsComplete : null,
      deciding: isDecidingSet(s),
    };
  });
  const inProgressIdx = parsed.findIndex(
    (s) =>
      s.us != null && s.them != null && s.complete !== true && (s.us < 25 && s.them < 25 || Math.abs(s.us - s.them) < 2)
  );
  const lastIdx = inProgressIdx >= 0 ? inProgressIdx : parsed.length - 1;
  const cur = parsed[lastIdx] || { us: 0, them: 0 };
  const setsWon = {
    us: parsed.filter((s) => s.us > s.them && (s.us >= 25 || s.complete === true)).length,
    them: parsed.filter((s) => s.them > s.us && (s.them >= 25 || s.complete === true)).length,
  };
  return {
    setIndex: lastIdx,
    setNumber: lastIdx + 1,
    us: cur.us ?? 0,
    them: cur.them ?? 0,
    setsWon,
    opponent: opponentName,
    rawSets: parsed,
  };
}

function detectLive(m, opponentName) {
  const start = pickFirst(m, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "MatchStartDateTime",
    "ScheduledStart",
    "StartTime",
  ]);
  const { ms } = parseTime(start);
  if (ms == null) return null;
  const now = Date.now();
  if (ms > now) return null;
  if (ms < now - 4 * 60 * 60 * 1000) return null;
  const finalized =
    typeof m?.IsComplete === "boolean"
      ? m.IsComplete
      : typeof m?.IsFinal === "boolean"
        ? m.IsFinal
        : null;
  if (finalized === true) return null;
  const won = teamWonMatch(m);
  const sets = setsFromMatch(m);
  if (won != null && sets.length && sets.every((s) => s?.IsComplete === true)) return null;
  if (!sets.length && finalized !== false) return null;
  return liveScoreShape(m, opponentName);
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
  let sets = null;
  if (done) {
    const won = teamWonMatch(m);
    if (won === true) result = "W";
    else if (won === false) result = "L";
    score = scoreString(m);
    const setArr = setsFromMatch(m);
    if (setArr.length) {
      sets = setArr
        .map((s) => {
          const { us, them } = setScores(s);
          return us != null && them != null
            ? { us, them, deciding: isDecidingSet(s) }
            : null;
        })
        .filter(Boolean);
    }
  }

  const endRaw = pickFirst(m, ["ScheduledEndDateTime", "EndDateTime", "MatchEndDateTime"]);
  const { iso: endISO } = parseTime(endRaw);

  const live = !done ? detectLive(m, opponent) : null;
  const videoLink =
    pickFirst(m?.CourtInfo || {}, ["VideoLink"]) ||
    pickFirst(m?.Court || {}, ["VideoLink"]) ||
    pickFirst(m, ["VideoLink", "WatchNowLink", "ScheduledVideoLink"]) ||
    null;

  return {
    id: pickFirst(m, ["MatchId", "Id", "ScheduleId"]) || `${start || "x"}-${opponent}`,
    done,
    result,
    score,
    sets,
    court,
    opponent,
    videoLink,
    time: iso ? formatLocalTime(iso) : null,
    timeISO: iso,
    timeMs: ms,
    endISO,
    live,
  };
}

function normalizeWork(w) {
  const start = pickFirst(w, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "WorkStartDateTime",
  ]);
  const { iso, ms } = parseTime(start);
  return {
    id: pickFirst(w, ["MatchId", "WorkAssignmentId", "Id"]) || `${start || "x"}-work`,
    role: pickFirst(w, ["WorkRole", "Role", "Assignment", "Position"]) || "Work duty",
    court:
      pickFirst(w, ["Court", "CourtName", "CourtText"]) ||
      pickFirst(w?.CourtInfo || {}, ["Name", "CourtName"]) ||
      "TBD",
    timeISO: iso,
    timeMs: ms,
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

function normalizeStandings(rows, teamId) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const bidStatus = r?.BidIdentification?.BidStatus;
    const earnedBid = bidStatus === 2 || bidStatus === "EarnedBid";
    return {
      teamId: r.TeamId,
      teamName: r.TeamName,
      isUs: String(r.TeamId) === String(teamId),
      rank: r.OverallRank ?? r.FinishRank ?? null,
      rankText: r.FinishRankText ?? null,
      matchesWon: r.MatchesWon ?? 0,
      matchesLost: r.MatchesLost ?? 0,
      setsWon: r.SetsWon ?? 0,
      setsLost: r.SetsLost ?? 0,
      setPercent: r.SetPercent ?? 0,
      pointRatio: r.PointRatio ?? 0,
      club: r.Club?.Name || null,
      earnedBid,
      bidAlias: earnedBid ? r?.BidIdentification?.DivisionAlias || null : null,
    };
  });
}

function teamsFromStandings(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      teamId: r.TeamId,
      teamName: r.TeamName,
      club: r.Club?.Name || null,
    }))
    .sort((a, b) => (a.teamName || "").localeCompare(b.teamName || ""));
}

function recordFromStandings(standings) {
  const us = standings.find((s) => s.isUs);
  if (!us) return { wins: 0, losses: 0 };
  return { wins: us.matchesWon, losses: us.matchesLost };
}

function buildResponse({ eventMeta, team, current, future, work, standings, nextAssignments, remoteTimestamp, ctx }) {
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
    g.next = !g.done && !firstUpcomingFlagged ? (firstUpcomingFlagged = true) : false;
    delete g.timeMs;
  }

  const liveGame = games.find((g) => !g.done && g.live);

  const standingsRows = normalizeStandings(standings?.value, ctx.teamId);
  const teams = teamsFromStandings(standings?.value);
  const record = recordFromStandings(standingsRows);
  const us = standingsRows.find((s) => s.isUs);
  const poolPosition = us ? us.rankText || (us.rank ? String(us.rank) : null) : null;

  const workAssignments = (Array.isArray(work) ? work : []).map(normalizeWork);

  const nextGameObj = games.find((g) => !g.done && g.timeISO);
  const nextWorkObj = workAssignments
    .filter((w) => w.timeMs && w.timeMs > Date.now())
    .sort((a, b) => a.timeMs - b.timeMs)[0];

  function asNext(o, kind) {
    if (!o) return null;
    const ms = o.timeMs ?? new Date(o.timeISO).getTime();
    return {
      kind,
      time: o.time,
      timeISO: o.timeISO,
      court: o.court,
      opponent: kind === "game" ? o.opponent : null,
      role: kind === "work" ? o.role : null,
      teams: kind === "work" ? o.teams : null,
      minutesUntil: Math.max(0, Math.round((ms - Date.now()) / 60000)),
    };
  }

  let nextEvent = null;
  const nextGameMs = nextGameObj?.timeISO ? new Date(nextGameObj.timeISO).getTime() : null;
  const nextWorkMs = nextWorkObj?.timeMs ?? null;
  if (nextGameMs && nextWorkMs) {
    nextEvent = nextGameMs <= nextWorkMs ? asNext(nextGameObj, "game") : asNext(nextWorkObj, "work");
  } else if (nextGameMs) {
    nextEvent = asNext(nextGameObj, "game");
  } else if (nextWorkMs) {
    nextEvent = asNext(nextWorkObj, "work");
  }

  const nextGame = nextGameObj
    ? {
        time: nextGameObj.time,
        timeISO: nextGameObj.timeISO,
        court: nextGameObj.court,
        opponent: nextGameObj.opponent,
        minutesUntil: Math.max(
          0,
          Math.round((new Date(nextGameObj.timeISO).getTime() - Date.now()) / 60000)
        ),
      }
    : null;

  let projectedDone = null;
  let projectedDoneSource = null;
  const lastWithEnd = [...games].reverse().find((g) => g.endISO);
  if (lastWithEnd) {
    projectedDone = lastWithEnd.endISO;
    projectedDoneSource = "scheduled";
  } else {
    const lastWithTime = [...games].reverse().find((g) => g.timeISO);
    if (lastWithTime) {
      const ms = new Date(lastWithTime.timeISO).getTime() + 75 * 60 * 1000;
      projectedDone = new Date(ms).toISOString();
      projectedDoneSource = "estimate";
    }
  }

  for (const w of workAssignments) delete w.timeMs;

  const event = eventMeta
    ? {
        id: eventMeta.Key || ctx.eventId,
        name: eventMeta.Name || null,
        location: (eventMeta.Location || "").trim() || null,
        startDate: eventMeta.StartDate || null,
        endDate: eventMeta.EndDate || null,
        isOver: eventMeta.IsOver === true,
      }
    : null;

  const teamWatchNowLink = team?.WatchNowLink || null;

  return {
    teamName: team?.TeamName || ctx.teamName,
    teamId: ctx.teamId,
    eventId: ctx.eventId,
    divisionId: ctx.divisionId,
    teamWatchNowLink,
    event,
    record,
    poolPosition,
    nextGame,
    nextEvent,
    liveGame: liveGame
      ? {
          ...liveGame.live,
          court: liveGame.court,
          time: liveGame.time,
          timeISO: liveGame.timeISO,
          gameId: liveGame.id,
          videoLink: liveGame.videoLink || null,
        }
      : null,
    projectedDone,
    projectedDoneSource,
    games,
    teams,
    standings: standingsRows,
    workAssignments,
    nextAssignmentsCount: Array.isArray(nextAssignments?.value) ? nextAssignments.value.length : 0,
    scrapedAt: new Date().toISOString(),
    remoteTimestamp,
    cached: false,
  };
}

async function loadFresh(ctx) {
  const { eventId, divisionId, teamId } = ctx;
  const urls = {
    event: `${AES_BASE}/api/event/${eventId}`,
    team: `${AES_BASE}/api/event/${eventId}/teams/${teamId}`,
    current: `${AES_BASE}/api/event/${eventId}/division/${divisionId}/team/${teamId}/schedule/current`,
    future: `${AES_BASE}/api/event/${eventId}/division/${divisionId}/team/${teamId}/schedule/future`,
    work: `${AES_BASE}/api/event/${eventId}/division/${divisionId}/team/${teamId}/schedule/work`,
    standings: `${AES_BASE}/odata/${eventId}/standings(dId=${divisionId},cId=null,tIds=[])`,
    nextAssignments: `${AES_BASE}/odata/${eventId}/nextassignments(dId=${divisionId},cId=null,tIds=[])`,
    timestamp: `${AES_BASE}/api/event/${eventId}/timestamp`,
  };
  const [eventMeta, team, current, future, work, standings, nextAssignments, timestamp] = await Promise.all([
    fetchJson(urls.event).catch(() => null),
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
    eventMeta,
    team,
    current,
    future,
    work,
    standings,
    nextAssignments,
    remoteTimestamp,
    ctx,
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

  const ctx = {
    eventId: String(req.query?.eventId || DEFAULT_EVENT_ID),
    divisionId: String(req.query?.divId || req.query?.divisionId || DEFAULT_DIVISION_ID),
    teamId: String(req.query?.teamId || DEFAULT_TEAM_ID),
    teamName: String(req.query?.teamName || DEFAULT_TEAM_NAME),
  };
  const cacheKey = `${ctx.eventId}|${ctx.divisionId}|${ctx.teamId}`;

  const force = req.query?.force === "1";
  const now = Date.now();
  const entry = cacheByKey.get(cacheKey);
  const cacheFresh = entry && now - entry.fetchedAt < CACHE_TTL_MS && entry.payload;

  try {
    if (!force && cacheFresh) {
      const ts = await fetchJson(`${AES_BASE}/api/event/${ctx.eventId}/timestamp`).catch(() => null);
      const remote = ts?.LastUpdatedTimestamp || null;
      if (remote && entry.remoteTimestamp && remote === entry.remoteTimestamp) {
        res.status(200).json({ ...entry.payload, cached: true });
        return;
      }
    }
    const { payload, remoteTimestamp } = await loadFresh(ctx);
    cacheByKey.set(cacheKey, { payload, fetchedAt: now, remoteTimestamp });
    res.status(200).json(payload);
  } catch (err) {
    if (entry?.payload) {
      res.status(200).json({ ...entry.payload, cached: true, staleError: String(err?.message || err) });
      return;
    }
    res.status(502).json({ error: String(err?.message || err) });
  }
}
