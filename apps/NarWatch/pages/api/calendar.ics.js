import { findTournament, TOURNAMENTS } from "../../lib/tournamentData.js";

const AES_BASE = "https://results.advancedeventsystems.com";

const VENUES = {
  PTAwMDAwNDI2MDU90: {
    name: "Liberty Lake Sports Complex",
    address: "1421 N Pepper Ln, Liberty Lake, WA 99019",
    tz: "America/Los_Angeles",
  },
};

const DEFAULT_VENUE = {
  name: "",
  address: "",
  tz: "America/Los_Angeles",
};

const TZ_VTIMEZONE_PT = `BEGIN:VTIMEZONE
TZID:America/Los_Angeles
X-LIC-LOCATION:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

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
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return null;
}

function setsFromMatch(m) {
  for (const k of ["Sets", "MatchSets", "Games", "GameResults"]) {
    if (Array.isArray(m?.[k])) return m[k];
  }
  return [];
}

function teamWonMatch(m) {
  const ours = pickFirst(m, ["TeamSetsWon", "OurSetsWon", "HomeTeamSetsWon"]);
  const theirs = pickFirst(m, ["OpponentSetsWon", "AwaySetsWon", "AwayTeamSetsWon"]);
  if (typeof ours === "number" && typeof theirs === "number") return ours > theirs ? "W" : "L";
  return null;
}

function scoreString(m) {
  const sets = setsFromMatch(m);
  if (!sets.length) return null;
  const parts = sets
    .map((s) => {
      const us = pickFirst(s, ["TeamScore", "OurScore", "HomeScore", "Team1Score"]);
      const them = pickFirst(s, ["OpponentScore", "AwayScore", "Team2Score"]);
      return us == null || them == null ? null : `${us}-${them}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function utcStamp(iso) {
  const d = new Date(iso);
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    "00Z"
  );
}

function escapeText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line) {
  if (line.length <= 75) return line;
  const out = [];
  let rest = line;
  out.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length) {
    out.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return out.join("\r\n");
}

function buildVEvent({ uid, start, end, summary, location, description, url, sequence }) {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(new Date().toISOString())}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SEQUENCE:${sequence || 0}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (url) lines.push(`URL:${url}`);
  // 30-min and 10-min alerts
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(summary)} starts in 30 min`,
    "TRIGGER:-PT30M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(summary)} starts in 10 min`,
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT"
  );
  return lines.map(foldLine).join("\r\n");
}

function hashSequence(input) {
  let h = 0;
  const s = JSON.stringify(input);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1_000_000;
}

// Build an ICS calendar from one or more static (NIWP) tournaments.
// When called with an array, all games across all tournaments are merged into
// a single persistent calendar — one subscribe URL covers the whole season.
function buildStaticTournamentICS(tournamentOrList, teamNameOverride) {
  const list = Array.isArray(tournamentOrList) ? tournamentOrList : [tournamentOrList];
  const appUrl = "https://narwatch.vercel.app";

  // Use the first tournament's teamName as the calendar-level name.
  const teamName = teamNameOverride || list[0]?.teamName || "North Idaho Narwhals";
  const calendarName = `${teamName} · Season`;
  const calDesc = `Full season schedule for ${teamName}. Auto-updates as scores and brackets are filled in.`;

  const events = [];

  for (const tournament of list) {
    const tName = teamNameOverride || tournament.teamName || teamName;
    const venue = tournament.venue || DEFAULT_VENUE;

    for (const g of tournament.games || []) {
      if (!g.timeISO) continue;
      const end = new Date(new Date(g.timeISO).getTime() + 75 * 60 * 1000).toISOString();

      const oppLabel = g.isBracket
        ? g.bracketSlot ? `Bracket vs Pool ${g.bracketSlot}` : "Bracket game"
        : g.opponent || "TBD";
      const summary =
        g.result === "W" ? `WON: ${tName} vs ${oppLabel}` :
        g.result === "L" ? `Lost: ${tName} vs ${oppLabel}` :
        g.isBracket      ? `${tName} — ${g.gameLabel || "Bracket game"}` :
                           `${tName} vs ${oppLabel}`;

      const court = g.court || "TBD";
      const location = venue.name
        ? `${court !== "TBD" ? court + " · " : ""}${venue.name}, ${venue.address || ""}`.trim().replace(/,\s*$/, "")
        : court;

      const descLines = [
        tournament.label ? `Tournament: ${tournament.label}` : null,
        g.gameLabel ? `Game: ${g.gameLabel}` : null,
        `Court: ${court}`,
        g.done && g.score ? `Score: ${g.score}` : null,
      ].filter(Boolean);

      events.push(
        buildVEvent({
          uid: `${g.id}@narwhaltracker`,
          start: g.timeISO,
          end,
          summary,
          location,
          description: descLines.join("\\n"),
          url: appUrl,
          sequence: hashSequence({ id: g.id, result: g.result, score: g.score }),
        })
      );
    }
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NarWatch//EN",
    "METHOD:PUBLISH",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-CALDESC:${escapeText(calDesc)}`,
    "X-WR-TIMEZONE:America/Los_Angeles",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export default async function handler(req, res) {
  const teamNameParam = req.query?.teamName ? String(req.query.teamName) : undefined;

  // Stable all-season path: ?teamId=narwhals (or any non-AES teamId).
  // Aggregates every static tournament in tournamentData.js into one persistent
  // calendar — subscribe once, covers the whole season.
  const teamIdParam = req.query?.teamId;
  if (teamIdParam === "narwhals") {
    const staticTournaments = TOURNAMENTS.filter((t) => t.static);
    const ics = buildStaticTournamentICS(staticTournaments, teamNameParam);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(ics);
    return;
  }

  // Single-tournament path (kept for direct links / debugging).
  const tournamentIdParam = req.query?.tournamentId;
  if (tournamentIdParam) {
    const tournament = findTournament(String(tournamentIdParam));
    if (!tournament) {
      res.status(404).send("Tournament not found");
      return;
    }
    const ics = buildStaticTournamentICS(tournament, teamNameParam);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(ics);
    return;
  }

  const eventId = String(req.query?.eventId || "PTAwMDAwNDI2MDU90");
  const divId = String(req.query?.divId || "203854");
  const teamId = String(req.query?.teamId || "201772");
  const teamName = String(req.query?.teamName || "North Idaho Narwhals");

  const venue = VENUES[eventId] || DEFAULT_VENUE;
  const aesUrl = `https://results.advancedeventsystems.com/event/${eventId}/division/${divId}/team/${teamId}`;

  const urls = {
    current: `${AES_BASE}/api/event/${eventId}/division/${divId}/team/${teamId}/schedule/current`,
    future: `${AES_BASE}/api/event/${eventId}/division/${divId}/team/${teamId}/schedule/future`,
    work: `${AES_BASE}/api/event/${eventId}/division/${divId}/team/${teamId}/schedule/work`,
  };

  let current = [], future = [], work = [];
  try {
    [current, future, work] = await Promise.all([
      fetchJson(urls.current).catch(() => []),
      fetchJson(urls.future).catch(() => []),
      fetchJson(urls.work).catch(() => []),
    ]);
  } catch {
    // continue with empties
  }

  const events = [];

  for (const m of (current || []).concat(future || [])) {
    const start = pickFirst(m, [
      "MatchDate",
      "ScheduledStartDateTime",
      "StartDateTime",
      "MatchStartDateTime",
      "ScheduledStart",
      "StartTime",
    ]);
    if (!start) continue;
    const endRaw = pickFirst(m, ["ScheduledEndDateTime", "EndDateTime", "MatchEndDateTime"]);
    const end = endRaw || new Date(new Date(start).getTime() + 75 * 60 * 1000).toISOString();
    const opponent =
      pickFirst(m, ["OpponentTeamName", "OpponentName", "AwayTeamName"]) ||
      pickFirst(m?.OpponentTeam || {}, ["TeamName", "Name"]) ||
      "TBD";
    const court =
      pickFirst(m, ["Court", "CourtName", "CourtText", "Location"]) ||
      pickFirst(m?.CourtInfo || {}, ["Name", "CourtName"]) ||
      "TBD";
    const matchId = pickFirst(m, ["MatchId", "Id", "ScheduleId"]) || `${start}-${opponent}`;

    const result = teamWonMatch(m);
    const score = scoreString(m);

    const summary =
      result === "W"
        ? `WON: ${teamName} vs ${opponent}`
        : result === "L"
          ? `Lost: ${teamName} vs ${opponent}`
          : `${teamName} vs ${opponent}`;

    const descriptionLines = [
      `Court: ${court}`,
      score ? `Score: ${score}` : null,
      `AES: ${aesUrl}`,
    ].filter(Boolean);

    const location = venue.name
      ? `Court ${court} · ${venue.name}, ${venue.address}`
      : `Court ${court}`;

    events.push(
      buildVEvent({
        uid: `match-${matchId}@narwhaltracker`,
        start,
        end,
        summary,
        location,
        description: descriptionLines.join("\\n"),
        url: aesUrl,
        sequence: hashSequence({ matchId, start, court, opponent, result, score }),
      })
    );
  }

  for (const w of work || []) {
    const start = pickFirst(w, [
      "MatchDate",
      "ScheduledStartDateTime",
      "StartDateTime",
      "WorkStartDateTime",
    ]);
    if (!start) continue;
    const endRaw = pickFirst(w, ["ScheduledEndDateTime", "EndDateTime", "WorkEndDateTime"]);
    const end = endRaw || new Date(new Date(start).getTime() + 75 * 60 * 1000).toISOString();
    const role = pickFirst(w, ["WorkRole", "Role", "Assignment", "Position"]) || "Work duty";
    const court =
      pickFirst(w, ["Court", "CourtName", "CourtText"]) ||
      pickFirst(w?.CourtInfo || {}, ["Name", "CourtName"]) ||
      "TBD";
    const id = pickFirst(w, ["MatchId", "WorkAssignmentId", "Id"]) || `${start}-work`;
    const teams =
      [pickFirst(w, ["HomeTeamName", "Team1Name"]), pickFirst(w, ["AwayTeamName", "Team2Name"])]
        .filter(Boolean)
        .join(" vs ") || null;

    const summary = `🟡 Work: ${role} (${teamName})`;
    const description = [
      teams ? `Match: ${teams}` : null,
      `Court: ${court}`,
      `AES: ${aesUrl}`,
    ]
      .filter(Boolean)
      .join("\\n");
    const location = venue.name
      ? `Court ${court} · ${venue.name}, ${venue.address}`
      : `Court ${court}`;

    events.push(
      buildVEvent({
        uid: `work-${id}@narwhaltracker`,
        start,
        end,
        summary,
        location,
        description,
        url: aesUrl,
        sequence: hashSequence({ id, start, court, role, teams }),
      })
    );
  }

  const calendarName = `${teamName} · ${venue.name || "Tournament"}`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NarWatch//EN",
    "METHOD:PUBLISH",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-CALDESC:${escapeText(`Live AES schedule for ${teamName}. Auto-updates if anything changes.`)}`,
    `X-WR-TIMEZONE:${venue.tz}`,
    TZ_VTIMEZONE_PT,
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(ics);
}
