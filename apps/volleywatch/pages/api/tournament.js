import { diffAndPush } from "@sport-tracker/core/stateDiff.js";
import { maybeSnapshot } from "@sport-tracker/core/snapshots.js";
import {
  findBroadcast,
  isInTournamentWindow,
  slugFromEventId,
  HUDL_TEAM_URL,
} from "../../lib/hudl-broadcasts.js";

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

// AES returns match datetimes as venue-local wall-clock with NO timezone
// offset (e.g. "2026-05-03T08:00:00"). On Vercel's UTC server, new Date()
// would treat that as UTC and shift the displayed time by 6–8 hours.
// Same fix pattern as parseDateAsPT() in apps/narwatch/pages/api/niwp.js:
// attach the venue's DST offset, verify with Intl, fall back to standard.
const TZ_OFFSETS = {
  "America/Los_Angeles": { dst: "-07:00", std: "-08:00", dstAbbr: "PDT" },
  "America/Denver":      { dst: "-06:00", std: "-07:00", dstAbbr: "MDT" },
};

function parseTimeInTz(value, tz) {
  if (!value) return { iso: null, ms: null };
  const s = String(value).trim();
  // Already has explicit TZ info (Z or ±hh:mm) — trust it.
  if (/[Zz]$/.test(s) || /[+-]\d{1,2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? { iso: null, ms: null } : { iso: d.toISOString(), ms: d.getTime() };
  }
  const offsets = TZ_OFFSETS[tz];
  if (!offsets) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? { iso: null, ms: null } : { iso: d.toISOString(), ms: d.getTime() };
  }
  const iso = s.replace(" ", "T");
  let attempt = new Date(iso + offsets.dst);
  if (Number.isNaN(attempt.getTime())) return { iso: null, ms: null };
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(attempt).find((p) => p.type === "timeZoneName")?.value || "";
  if (!tzLabel.includes(offsets.dstAbbr)) {
    attempt = new Date(iso + offsets.std);
    if (Number.isNaN(attempt.getTime())) return { iso: null, ms: null };
  }
  return { iso: attempt.toISOString(), ms: attempt.getTime() };
}

function parseTime(value, tz) {
  return parseTimeInTz(value, tz);
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

// AES WorkTeamCourtAssignmentFlag is a bitmask:
//   1 = PreviousMatchSameCourt, 2 = NextMatchSameCourt,
//   4 = NextMatchSameCourtIfWin, 8 = NextMatchSameCourtIfLoss,
//   16 = WorkTeamAssignmentIsNotDefinite.
// AES exposes two fields per match (First/Second team perspective). We OR
// them together since we don't always know which side our team is, and
// surface boolean hints derived from the bits we care about.
function courtStayHints(m) {
  const a = Number(m?.FirstTeamWorkTeamCourtAssignmentFlag) || 0;
  const b = Number(m?.SecondTeamWorkTeamCourtAssignmentFlag) || 0;
  const flag = a | b;
  if (!flag) return null;
  const stay = (flag & 2) === 2;
  const stayIfWin = (flag & 4) === 4;
  const stayIfLoss = (flag & 8) === 8;
  if (!stay && !stayIfWin && !stayIfLoss) return null;
  return { stay, stayIfWin, stayIfLoss };
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
      return `${us}–${them}`;
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

function detectLive(m, opponentName, tz) {
  const start = pickFirst(m, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "MatchStartDateTime",
    "ScheduledStart",
    "StartTime",
  ]);
  const { ms } = parseTime(start, tz);
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

function normalizeMatch(m, { done, idx = 0, kind = "match", teamId = null, tz = null }) {
  const start = pickFirst(m, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "MatchStartDateTime",
    "ScheduledStart",
    "StartTime",
  ]);
  const { iso, ms } = parseTime(start, tz);
  const _firstId = String(m?.FirstTeamId ?? "");
  const _isFirst = teamId && _firstId === String(teamId);
  const opponent =
    (_isFirst ? m?.SecondTeamName : _firstId ? m?.FirstTeamName : null) ||
    pickFirst(m, ["OpponentTeamName", "OpponentName", "AwayTeamName"]) ||
    pickFirst(m?.OpponentTeam || {}, ["TeamName", "Name"]) ||
    "TBD";
  const court =
    (typeof m?.Court === "object" ? m?.Court?.Name : null) ||
    pickFirst(m, ["CourtName", "CourtText", "Location"]) ||
    pickFirst(m?.CourtInfo || {}, ["Name", "CourtName"]) ||
    "TBD";

  let result = null;
  let score = null;
  let sets = null;
  if (done) {
    let won = null;
    if (teamId && m?.FirstTeamId != null) {
      const isFirst = String(m.FirstTeamId) === String(teamId);
      const myWon = isFirst ? m.FirstTeamWon : m.SecondTeamWon;
      // Read W/L from explicit flags regardless of HasScores — pool play
      // matches have HasScores:false but FirstTeamWon/SecondTeamWon are set.
      if (myWon === true || myWon === false) {
        won = myWon;
      } else {
        // Explicit W/L flag absent — common for bracket/playoff games served
        // by the schedule endpoint. Derive from per-set scores using isFirst
        // to determine which side is ours (First vs Second in bracket format).
        const rawSets = setsFromMatch(m);
        let usWins = 0, themWins = 0;
        for (const s of rawSets) {
          const fs = pickFirst(s, ["FirstTeamScore", "Team1Score"]);
          const ss = pickFirst(s, ["SecondTeamScore", "Team2Score"]);
          if (typeof fs === "number" && typeof ss === "number" && fs !== ss) {
            if (isFirst ? fs > ss : ss > fs) usWins++; else themWins++;
          }
        }
        if (usWins > 0 || themWins > 0) won = usWins > themWins;
      }
    }
    if (won === null) won = teamWonMatch(m);
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
  const { iso: endISO } = parseTime(endRaw, tz);

  const courtStay = !done ? courtStayHints(m) : null;

  const live = !done ? detectLive(m, opponent, tz) : null;
  const videoLink =
    pickFirst(m?.CourtInfo || {}, ["VideoLink"]) ||
    pickFirst(m?.Court || {}, ["VideoLink"]) ||
    pickFirst(m, ["VideoLink", "WatchNowLink", "ScheduledVideoLink"]) ||
    null;

  return {
    id:
      pickFirst(m, ["MatchId", "Id", "ScheduleId"])?.toString() ||
      `${kind}-${idx}-${start || "x"}-${opponent}`,
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
    courtStay,
    live,
  };
}

function normalizeWork(w, idx = 0, tz = null) {
  const start = pickFirst(w, [
    "MatchDate",
    "ScheduledStartDateTime",
    "StartDateTime",
    "WorkStartDateTime",
  ]);
  const { iso, ms } = parseTime(start, tz);
  return {
    id:
      pickFirst(w, ["MatchId", "WorkAssignmentId", "Id"])?.toString() ||
      `work-${idx}-${start || "x"}`,
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
      setPercent: parseFloat(r.SetPercent ?? 0) || 0,
      pointRatio: parseFloat(r.PointRatio ?? 0) || 0,
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

// Recursively scan a brackets blob for any Match objects involving
// teamId. AES nests matches at multiple depths (Roots[].Match,
// FutureRoundMatches[].Match, BottomSource.Match, etc.) so a deep walk
// is the only reliable way to surface the team's full played history
// when /schedule/current returns []. Pool play matches are NOT in this
// blob — AES doesn't expose pool-match details on public endpoints.
function extractTeamMatchesFromBrackets(brackets, teamIdStr) {
  if (!brackets) return [];
  const teamId = Number(teamIdStr);
  const found = new Map();
  const seen = new WeakSet();
  function visit(obj) {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const v of obj) visit(v);
      return;
    }
    if (
      obj.MatchId != null &&
      "FirstTeam" in obj &&
      "SecondTeam" in obj &&
      "Sets" in obj
    ) {
      const ftId = obj.FirstTeam?.TeamId;
      const stId = obj.SecondTeam?.TeamId;
      if (ftId === teamId || stId === teamId) {
        if (!found.has(obj.MatchId)) {
          found.set(obj.MatchId, obj);
        }
      }
    }
    for (const v of Object.values(obj)) visit(v);
  }
  visit(brackets);
  return Array.from(found.values());
}

// Walk a single bracket and emit a flat match list with parent/child
// relationships preserved via depth + feedsInto. Roots are at depth 0
// (the championship of each branch), feeders (BottomSource / TopSource)
// at depth 1+.
function buildBracketStructure(bracket, teamIdStr) {
  const teamId = Number(teamIdStr);
  const matches = [];
  const stripTag = (s) => String(s || "").replace(/\s*\([^)]*\)\s*$/, "").trim();

  function emitMatch(matchObj, depth, parentId) {
    if (!matchObj || typeof matchObj !== "object") return null;
    const ftId = matchObj.FirstTeam?.TeamId;
    const stId = matchObj.SecondTeam?.TeamId;
    const usFirst = ftId === teamId;
    const usSecond = stId === teamId;
    const isUs = usFirst || usSecond;
    const sets = (matchObj.Sets || [])
      .map((s) => {
        const fs = s.FirstTeamScore;
        const ss = s.SecondTeamScore;
        if (fs == null && ss == null) return null;
        return {
          first: fs,
          second: ss,
          deciding: s.IsDecidingSet === true,
        };
      })
      .filter(Boolean);
    const id = matchObj.MatchId != null ? String(matchObj.MatchId) : null;
    const m = {
      matchId: id,
      fullName: matchObj.FullName || null,
      shortName: matchObj.ShortName || null,
      court: matchObj.Court?.Name || null,
      scheduledStart: matchObj.ScheduledStartDateTime || null,
      firstTeam: {
        teamId: ftId ?? null,
        name:
          stripTag(matchObj.FirstTeam?.Name || matchObj.FirstTeamText) || "TBD",
        isUs: usFirst,
        won: matchObj.FirstTeamWon === true,
      },
      secondTeam: {
        teamId: stId ?? null,
        name:
          stripTag(matchObj.SecondTeam?.Name || matchObj.SecondTeamText) || "TBD",
        isUs: usSecond,
        won: matchObj.SecondTeamWon === true,
      },
      hasScores: matchObj.HasScores === true,
      sets,
      depth,
      feedsInto: parentId,
      usPath: isUs,
    };
    matches.push(m);
    return id;
  }

  function walkRootNode(node, depth, parentId) {
    if (!node || typeof node !== "object") return;
    // A root node is { Match, BottomSource, TopSource, X, Y, ... }.
    // Source nodes have the same shape (recursive feeders).
    const m = node.Match;
    let myId = parentId;
    if (m && m.MatchId != null) {
      myId = emitMatch(m, depth, parentId);
    }
    if (node.BottomSource) walkRootNode(node.BottomSource, depth + 1, myId);
    if (node.TopSource) walkRootNode(node.TopSource, depth + 1, myId);
  }

  for (const r of bracket.Roots || []) {
    walkRootNode(r, 0, null);
  }
  return matches;
}

function extractBracketsForTeam(brackets, teamIdStr) {
  if (!Array.isArray(brackets) || brackets.length === 0) return [];
  const teamId = Number(teamIdStr);
  const out = [];
  for (const b of brackets) {
    // Quick check: does this bracket reference our team anywhere?
    const has = (function check(obj) {
      if (!obj || typeof obj !== "object") return false;
      if (obj.TeamId === teamId) return true;
      if (Array.isArray(obj)) return obj.some(check);
      for (const v of Object.values(obj)) if (check(v)) return true;
      return false;
    })(b);
    if (!has) continue;
    const matches = buildBracketStructure(b, teamIdStr);
    if (matches.length === 0) continue;
    out.push({
      bracketId: String(b.PlayId ?? b.ShortName ?? b.FullName),
      name: b.FullName || b.ShortName || "Bracket",
      shortName: b.ShortName || null,
      order: b.Order ?? 0,
      matches,
    });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

function bracketMatchToGame(m, teamIdStr, tz = null) {
  const teamId = Number(teamIdStr);
  const ourSide = m.FirstTeam?.TeamId === teamId ? "first" : "second";
  const won =
    ourSide === "first" ? m.FirstTeamWon === true : m.SecondTeamWon === true;
  const lost =
    ourSide === "first" ? m.SecondTeamWon === true : m.FirstTeamWon === true;
  // Prefer .Name over .Text — the latter carries trailing region tags
  // like " (EV)" that don't match the standings TeamName, breaking
  // head-to-head joins. Strip any residual trailing-paren tags too.
  const rawOpponent =
    ourSide === "first"
      ? m.SecondTeam?.Name || m.SecondTeamText || "TBD"
      : m.FirstTeam?.Name || m.FirstTeamText || "TBD";
  const opponent = String(rawOpponent).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const sets = (m.Sets || [])
    .map((s) => {
      const fs = s.FirstTeamScore;
      const ss = s.SecondTeamScore;
      if (fs == null || ss == null) return null;
      return ourSide === "first"
        ? { us: fs, them: ss, deciding: s.IsDecidingSet === true }
        : { us: ss, them: fs, deciding: s.IsDecidingSet === true };
    })
    .filter(Boolean);
  const start = m.ScheduledStartDateTime || null;
  const { iso, ms } = parseTime(start, tz);
  const score = sets.length ? sets.map((s) => `${s.us}–${s.them}`).join(", ") : null;
  const courtName =
    m.Court?.Name ||
    (typeof m.Court === "string" ? m.Court : null) ||
    "TBD";
  return {
    id: String(m.MatchId),
    done: won || lost,
    result: won ? "W" : lost ? "L" : null,
    score,
    sets: sets.length ? sets : null,
    court: courtName,
    opponent,
    videoLink: m.Court?.VideoLink || null,
    time: iso ? formatLocalTime(iso) : null,
    timeISO: iso,
    timeMs: ms,
    endISO: m.ScheduledEndDateTime || null,
    courtStay: null,
    live: null,
    next: false,
  };
}

function extractPoolForTeam(pools, teamIdStr) {
  if (!Array.isArray(pools) || pools.length === 0) return null;
  const teamId = Number(teamIdStr);
  const pool = pools.find((p) =>
    Array.isArray(p?.Teams) && p.Teams.some((t) => t?.TeamId === teamId)
  );
  if (!pool) return null;
  const teams = (pool.Teams || []).map((t) => ({
    teamId: t.TeamId,
    name: t.TeamName,
    isUs: t.TeamId === teamId,
    rank: t.FinishRank ?? null,
    rankText: t.FinishRankText ?? null,
    wins: t.MatchesWon ?? 0,
    losses: t.MatchesLost ?? 0,
    setsWon: t.SetsWon ?? 0,
    setsLost: t.SetsLost ?? 0,
    setPercent: parseFloat(t.SetPercent ?? 0) || 0,
    pointRatio: parseFloat(t.PointRatio ?? 0) || 0,
    club: t.Club?.Name || null,
  }));
  // Pool API doesn't always populate FinishRank during early/in-progress
  // play; fall back to sorting by setPercent then pointRatio.
  teams.sort((a, b) => {
    if (a.rank != null && b.rank != null && a.rank !== b.rank) return a.rank - b.rank;
    if (b.setPercent !== a.setPercent) return b.setPercent - a.setPercent;
    return b.pointRatio - a.pointRatio;
  });
  return {
    poolName: pool.FullName || pool.ShortName || "Pool",
    matchDescription: pool.MatchDescription || null,
    courts: (pool.Courts || []).map((c) => c.Name).filter(Boolean),
    teams,
  };
}

// AES schedule endpoints return play-group-wrapped arrays:
// [{ Play: {..., Courts: [...]}, Matches: [{match}, ...] }]
// Flatten into a plain match array, injecting court from the Play
// group when the individual match lacks it.
function flattenPlayGroups(raw) {
  if (!Array.isArray(raw)) return [];
  if (!raw.length || !raw[0]?.Matches) return raw;
  return raw.flatMap((group) => {
    const playCourt = group?.Play?.Courts?.[0] || null;
    return (group.Matches || []).map((m) => {
      if (!m.Court && playCourt) return { ...m, Court: playCourt };
      return m;
    });
  });
}

function buildResponse({ eventMeta, team, current, future, work, standings, nextAssignments, brackets, pools, remoteTimestamp, ctx }) {
  const playedRaw = flattenPlayGroups(current);
  const upcomingRaw = flattenPlayGroups(future);

  const played = playedRaw.map((m, i) => normalizeMatch(m, { done: true, idx: i, kind: "past", teamId: ctx.teamId, tz: ctx.tz }));
  const upcoming = upcomingRaw.map((m, i) => normalizeMatch(m, { done: false, idx: i, kind: "next", teamId: ctx.teamId, tz: ctx.tz }));

  const games = [...played, ...upcoming]
    .filter((g) => g.timeMs != null || g.timeISO != null)
    .sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));
  if (!games.length && (played.length || upcoming.length)) {
    games.push(...played, ...upcoming);
  }

  // Merge in bracket-derived matches that aren't already present. AES
  // schedule/current returns [] for concluded tournaments, but the
  // brackets blob still carries the full match history with scores —
  // backfill gives us 'past games' even after the tournament ends.
  // (Pool play matches aren't exposed by AES public endpoints; this
  // covers cross-bracket / playoff matches only.)
  if (Array.isArray(brackets) && brackets.length > 0) {
    const have = new Set(games.map((g) => String(g.id)));
    const bracketGames = extractTeamMatchesFromBrackets(brackets, ctx.teamId)
      .map((m) => bracketMatchToGame(m, ctx.teamId, ctx.tz))
      .filter((g) => !have.has(String(g.id)));
    if (bracketGames.length > 0) {
      games.push(...bracketGames);
      games.sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));
    }
  }

  // Hudl Fan watch buttons: fuzzy-match each game's opponent against the
  // static broadcast map for this tournament. Adds `watchUrl` only when a
  // match is found — absent on TBD/upcoming games and on tournaments with
  // no broadcasts mapped yet.
  const tournamentSlug = slugFromEventId(ctx.eventId);
  for (const g of games) {
    const hudl = findBroadcast(g.opponent, tournamentSlug);
    if (hudl) g.watchUrl = hudl.watchUrl;
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

  const workAssignments = (Array.isArray(work) ? work : []).map((w, i) => normalizeWork(w, i, ctx.tz));

  const nextGameObj = games.find((g) => !g.done && g.timeISO);
  const nextWorkObj = workAssignments
    .filter((w) => w.timeMs && w.timeMs > Date.now())
    .sort((a, b) => a.timeMs - b.timeMs)[0];

  function asNext(o, kind) {
    if (!o) return null;
    const ms = o.timeMs ?? new Date(o.timeISO).getTime();
    const isRunningLate =
      kind === "game" &&
      ms < Date.now() &&
      !o.live &&
      !(Array.isArray(o.sets) && o.sets.length > 0) &&
      !o.score;
    return {
      kind,
      time: o.time,
      timeISO: o.timeISO,
      court: o.court,
      opponent: kind === "game" ? o.opponent : null,
      role: kind === "work" ? o.role : null,
      teams: kind === "work" ? o.teams : null,
      minutesUntil: Math.max(0, Math.round((ms - Date.now()) / 60000)),
      isRunningLate,
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

  // "Running late" = scheduled start has passed but the match hasn't
  // started yet (no scores logged and no live banner). AES doesn't
  // expose actual start times, so this is the best signal we can derive
  // — strictly binary, no minute-count.
  const nextGame = nextGameObj
    ? (() => {
        const startMs = new Date(nextGameObj.timeISO).getTime();
        const isRunningLate =
          startMs < Date.now() &&
          !nextGameObj.live &&
          !(Array.isArray(nextGameObj.sets) && nextGameObj.sets.length > 0) &&
          !nextGameObj.score;
        return {
          time: nextGameObj.time,
          timeISO: nextGameObj.timeISO,
          court: nextGameObj.court,
          opponent: nextGameObj.opponent,
          minutesUntil: Math.max(0, Math.round((startMs - Date.now()) / 60000)),
          isRunningLate,
        };
      })()
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

  // Prefer AES's own WatchNowLink when present (rare — most events don't set it).
  // Otherwise fall back to the Hudl Fan team page during known game-day windows
  // (today's date matches a tournament date AND the local hour is 7am–7pm).
  const teamWatchNowLink =
    team?.WatchNowLink ||
    (isInTournamentWindow(tournamentSlug) ? HUDL_TEAM_URL : null);

  const bracketStructures = extractBracketsForTeam(brackets, ctx.teamId);
  const pool = extractPoolForTeam(pools, ctx.teamId);

  return {
    teamName: team?.TeamName || ctx.teamName,
    teamId: ctx.teamId,
    eventId: ctx.eventId,
    divisionId: ctx.divisionId,
    teamWatchNowLink,
    event,
    brackets: bracketStructures,
    pool,
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
    brackets: `${AES_BASE}/api/event/${eventId}/division/${divisionId}/brackets`,
    pools: `${AES_BASE}/api/event/${eventId}/division/${divisionId}/pools`,
    timestamp: `${AES_BASE}/api/event/${eventId}/timestamp`,
  };
  const [eventMeta, team, current, future, work, standings, nextAssignments, brackets, pools, timestamp] = await Promise.all([
    fetchJson(urls.event).catch(() => null),
    fetchJson(urls.team).catch(() => null),
    fetchJson(urls.current).catch(() => []),
    fetchJson(urls.future).catch(() => []),
    fetchJson(urls.work).catch(() => []),
    fetchJson(urls.standings).catch(() => ({ value: [] })),
    fetchJson(urls.nextAssignments).catch(() => ({ value: [] })),
    fetchJson(urls.brackets).catch(() => []),
    fetchJson(urls.pools).catch(() => []),
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
    brackets,
    pools,
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
    tz: req.query?.tz ? String(req.query.tz) : "America/Los_Angeles",
  };
  const cacheKey = `${ctx.eventId}|${ctx.divisionId}|${ctx.teamId}|${ctx.tz}`;

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
    // Fire-and-forget state diff + push. Awaited best-effort; failure is
    // logged but never affects the API response.
    diffAndPush({
      eventId: ctx.eventId,
      teamId: ctx.teamId,
      teamName: payload?.teamName || ctx.teamName,
      payload,
    }).catch((err) => console.error("[diffAndPush]", err?.message || err));
    // Fire-and-forget snapshot — rate-limited to one write per 5 min in
    // the helper, plus a single terminal write when the event ends.
    maybeSnapshot({
      eventId: ctx.eventId,
      tournamentId: req.query?.tournamentId || null,
      payload,
    }).catch((err) => console.error("[snapshot]", err?.message || err));
  } catch (err) {
    if (entry?.payload) {
      res.status(200).json({ ...entry.payload, cached: true, staleError: String(err?.message || err) });
      return;
    }
    res.status(502).json({ error: String(err?.message || err) });
  }
}
