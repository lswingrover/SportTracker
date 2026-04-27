const AES_BASE = "https://results.advancedeventsystems.com";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`AES ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function teamAppears(node, teamId) {
  if (!node) return false;
  if (typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => teamAppears(n, teamId));
  if (node.TeamId === teamId) return true;
  for (const k of ["FirstTeam", "SecondTeam", "WorkTeam"]) {
    if (node[k]?.TeamId === teamId) return true;
  }
  for (const k in node) {
    if (k === "Division" || k === "Club" || k === "BidIdentification") continue;
    const v = node[k];
    if (v && typeof v === "object" && teamAppears(v, teamId)) return true;
  }
  return false;
}

function normalizeMatch(m, teamId) {
  if (!m) return null;
  const sets = Array.isArray(m.Sets)
    ? m.Sets.map((s) => ({
        first: s.FirstTeamScore ?? s.TeamScore ?? null,
        second: s.SecondTeamScore ?? s.OpponentScore ?? null,
        deciding: s.IsDecidingSet === true,
      })).filter((s) => s.first != null && s.second != null)
    : [];
  const firstWon = m.FirstTeamWon === true;
  const secondWon = m.SecondTeamWon === true;
  const firstId = m.FirstTeam?.TeamId ?? m.FirstTeamId ?? null;
  const secondId = m.SecondTeam?.TeamId ?? m.SecondTeamId ?? null;
  const ourSide =
    firstId === teamId ? "first" : secondId === teamId ? "second" : null;
  let result = null;
  if (ourSide === "first") result = firstWon ? "W" : secondWon ? "L" : null;
  if (ourSide === "second") result = secondWon ? "W" : firstWon ? "L" : null;

  return {
    matchId: m.MatchId ?? null,
    name: m.FullName || m.ShortName || null,
    first: {
      teamId: firstId,
      name: m.FirstTeam?.Name || m.FirstTeamName || null,
      text: m.FirstTeamText || null,
      isUs: firstId === teamId,
      won: firstWon,
    },
    second: {
      teamId: secondId,
      name: m.SecondTeam?.Name || m.SecondTeamName || null,
      text: m.SecondTeamText || null,
      isUs: secondId === teamId,
      won: secondWon,
    },
    sets,
    hasScores: m.HasScores === true,
    court: m.Court?.Name || null,
    courtId: m.Court?.CourtId || null,
    videoLink: m.Court?.VideoLink || null,
    startISO: m.ScheduledStartDateTime || null,
    endISO: m.ScheduledEndDateTime || null,
    workTeam: m.WorkTeamText || null,
    typeOfOutcome: typeof m.TypeOfOutcome === "number" ? m.TypeOfOutcome : null,
    ourSide,
    result,
  };
}

function normalizeBracket(b, teamId) {
  const roots = (b.Roots || [])
    .map((r) => ({
      x: typeof r.X === "number" ? r.X : 0,
      y: typeof r.Y === "number" ? r.Y : 0,
      reversed: r.Reversed === true,
      match: normalizeMatch(r.Match, teamId),
    }))
    .filter((r) => r.match);
  const future = (b.FutureRoundMatches || []).map((fm) => ({
    rankText: fm.RankText || null,
    nextPendingReseed: fm.NextPendingReseed === true,
    workDecided: fm.WorkTeamAssignmentDecided === true,
    match: normalizeMatch(fm.Match, teamId),
  }));
  return {
    name: b.FullName || b.ShortName || "Bracket",
    shortName: b.ShortName || null,
    completeName: b.CompleteFullName || null,
    playId: b.PlayId,
    order: b.Order || 0,
    courts: (b.Courts || []).map((c) => c.Name || c.CourtId).filter(Boolean),
    notes: b.BracketNotes || null,
    roots,
    future,
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

  const eventId = String(req.query?.eventId || "PTAwMDAwNDI2MDU90");
  const divId = String(req.query?.divId || "203854");
  const teamIdNum = Number(req.query?.teamId || 0) || null;

  const key = `${eventId}|${divId}`;
  const now = Date.now();
  const entry = cache.get(key);

  let brackets;
  if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    brackets = entry.data;
  } else {
    try {
      brackets = await fetchJson(
        `${AES_BASE}/api/event/${eventId}/division/${divId}/brackets`
      );
      cache.set(key, { fetchedAt: now, data: brackets });
    } catch (err) {
      if (entry) {
        brackets = entry.data;
      } else {
        res.status(502).json({ error: String(err.message || err) });
        return;
      }
    }
  }

  const all = Array.isArray(brackets) ? brackets : [];
  const ours = teamIdNum
    ? all.filter((b) => teamAppears(b, teamIdNum))
    : all.slice(0, 4);

  const normalized = ours.map((b) => normalizeBracket(b, teamIdNum));

  res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120");
  res.status(200).json({
    eventId,
    divId,
    teamId: teamIdNum,
    matchedBrackets: normalized,
    totalBracketsInDivision: all.length,
    scrapedAt: new Date().toISOString(),
  });
}
