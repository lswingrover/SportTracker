// NarWatch: SportsEngine / TourneyMachine HTML scraper adapter.
//
// Scrapes tourneymachine.com tournament and division pages to extract
// game schedules and scores. No API key required.
//
// URL patterns:
//   Tournament: https://tourneymachine.com/Public/Results/Tournament.aspx?IDTournament={id}
//   Division:   ...Division.aspx?IDTournament={t}&IDDivision={d}
//
// OUTPUT: same JSON shape as tormatch.js / niwp.js so the frontend is
// unaffected. Also includes _pollSchedule for adaptive client polling.

import * as cheerio from "cheerio";
import { computePollSchedule } from "../../lib/pollSchedule.js";

const TOURNEYMACHINE_BASE = "https://tourneymachine.com";
const CACHE_TTL_MS        = 5 * 60 * 1000; // 5 min — scores aren't real-time

// Module-level cache
let _cache     = null;
let _fetchedAt = 0;
let _cacheKey  = "";

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`TourneyMachine fetch ${url} → ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tournament page ──────────────────────────────────────────────────────────

async function fetchTournament(tournamentId) {
  const url = `${TOURNEYMACHINE_BASE}/Public/Results/Tournament.aspx?IDTournament=${tournamentId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const name     = $("h1").first().text().trim() || `Tournament ${tournamentId}`;
  const dates    = $("#tournamentDates").text().trim()    || null;
  const location = $("#tournamentLocation").text().trim() || null;

  const divisions = [];
  $('a[href*="Division.aspx"]').each((_, el) => {
    const href  = $(el).attr("href") || "";
    const match = href.match(/IDDivision=([^&]+)/i);
    if (!match) return;
    const id   = match[1];
    const divName = $(el).text().trim() || `Division ${id}`;
    // Deduplicate
    if (!divisions.some((d) => d.id === id)) {
      divisions.push({ id, name: divName });
    }
  });

  return { name, dates, location, divisions };
}

// ─── Division page ────────────────────────────────────────────────────────────

// Parse a date-header string like "Sunday, August 10, 2025" into a Date object.
function parseDateHeader(text) {
  if (!text) return null;
  try {
    const d = new Date(text.trim());
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// Parse a time string like "8:30 AM" into HH:MM:SS (24h) for combining with a date.
function parseTimeString(timeText) {
  if (!timeText) return null;
  const clean = timeText.trim().replace(/\s+/g, " ");
  const m = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}:00`;
}

async function fetchDivisionGames(tournamentId, divisionId) {
  const url =
    `${TOURNEYMACHINE_BASE}/Public/Results/Division.aspx` +
    `?IDTournament=${tournamentId}&IDDivision=${divisionId}`;
  const html  = await fetchHtml(url);
  const $     = cheerio.load(html);
  const games = [];

  let currentDate = null; // tracks the most recent date-header row

  $("table.tournamentResultsTable tr").each((_, row) => {
    const cells = $(row).find("td, th");
    const cellCount = cells.length;

    // Date-header row: single spanning cell (th with colspan or td spanning most columns)
    if (cellCount === 1) {
      const cell = cells.first();
      const colspan = parseInt(cell.attr("colspan") || "1", 10);
      if (colspan > 1) {
        // This is a date header row
        const parsed = parseDateHeader(cell.text().trim());
        if (parsed) currentDate = parsed;
        return; // skip — not a game row
      }
    }

    // Game row: expect exactly 7 cells
    if (cellCount !== 7) return;

    const gameNumber = $(cells.get(0)).text().trim();
    // If cell 0 doesn't look like a game ID (letters/numbers), skip
    if (!gameNumber || !/^[A-Za-z0-9]+$/.test(gameNumber)) return;

    // Cell 1: time — may contain a hidden date div; take the last non-empty line
    const timeRaw  = $(cells.get(1)).text().trim();
    const timeLines = timeRaw.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
    const timeText  = timeLines[timeLines.length - 1] || null;

    const location = $(cells.get(2)).text().trim() || null;
    const teamA    = $(cells.get(3)).text().trim() || "";
    const scoreARaw = $(cells.get(4)).text().trim();
    const scoreBRaw = $(cells.get(5)).text().trim();
    const teamB    = $(cells.get(6)).text().trim() || "";

    const scoreA = scoreARaw !== "" && !isNaN(parseInt(scoreARaw, 10))
      ? parseInt(scoreARaw, 10) : null;
    const scoreB = scoreBRaw !== "" && !isNaN(parseInt(scoreBRaw, 10))
      ? parseInt(scoreBRaw, 10) : null;

    games.push({
      gameNumber,
      time:       timeText,
      location,
      teamA,
      scoreA,
      teamB,
      scoreB,
      _date:      currentDate, // the date header in effect for this row
    });
  });

  return games;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeGame(raw, tournamentId, divisionName, narwhalsFragment) {
  const frag = (narwhalsFragment || "narwhal").toLowerCase();
  const aIsUs = raw.teamA.toLowerCase().includes(frag);
  const bIsUs = raw.teamB.toLowerCase().includes(frag);

  const ourScore   = aIsUs ? raw.scoreA : bIsUs ? raw.scoreB  : null;
  const theirScore = aIsUs ? raw.scoreB : bIsUs ? raw.scoreA  : null;
  const opponent   = aIsUs ? raw.teamB  : bIsUs ? raw.teamA   : (raw.teamB || raw.teamA || "Unknown");

  // Build timeISO from date header + time string
  let timeISO = null;
  if (raw._date && raw.time) {
    const hms = parseTimeString(raw.time);
    if (hms) {
      try {
        const d = new Date(raw._date);
        const [h, m, s] = hms.split(":").map(Number);
        d.setHours(h, m, s, 0);
        if (!isNaN(d.getTime())) timeISO = d.toISOString();
      } catch {}
    }
  }

  const done = raw.scoreA !== null && raw.scoreB !== null;
  let result = null;
  if (done && ourScore !== null && theirScore !== null) {
    result = ourScore > theirScore ? "W" : ourScore < theirScore ? "L" : "T";
  }

  const sets = (ourScore !== null || theirScore !== null)
    ? [{ us: ourScore ?? 0, them: theirScore ?? 0 }]
    : [];

  const id = `${tournamentId}-${divisionName}-${raw.gameNumber}`.replace(/\s+/g, "_");

  return {
    id,
    opponent:   opponent || "Unknown",
    timeISO,
    court:      raw.location || null,
    done,
    result,
    sets,
    round:      raw.gameNumber || null,
    notes:      null,
    _division:  divisionName,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const tournamentId = req.query.id      || process.env.SPORTSENGINE_TOURNAMENT_ID || "";
  const teamName     = req.query.teamName || process.env.SPORTSENGINE_TEAM_NAME    || "Narwhal";
  const force        = req.query.force === "1";
  const now          = Date.now();

  if (!tournamentId) {
    return res.status(400).json({ error: "sportsengine_missing_tournament_id", detail: "Provide ?id= or set SPORTSENGINE_TOURNAMENT_ID" });
  }

  const cacheKey = `${tournamentId}|${teamName}`;

  if (!force && _cache && _cacheKey === cacheKey && now - _fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.status(200).json({ ..._cache, cached: true });
  }

  try {
    // 1. Fetch tournament meta + division list
    const tournament = await fetchTournament(tournamentId);

    // 2. Fetch all divisions in parallel
    const divisionResults = await Promise.allSettled(
      tournament.divisions.map(async (div) => {
        const rawGames = await fetchDivisionGames(tournamentId, div.id);
        return rawGames.map((g) => normalizeGame(g, tournamentId, div.name, teamName));
      })
    );

    // Flatten, skip failed divisions gracefully
    const allGames = divisionResults.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    const frag = teamName.toLowerCase();
    const ourGames  = allGames.filter((g) => {
      // A game is "ours" if opponent doesn't include our frag but at least one
      // side does — determined during normalizeGame by result/sets presence.
      // Simpler: any game where opponent is not us (normalizeGame sets opponent
      // to the other team when it found us).
      return g.result !== null || g.done
        ? true
        : g.opponent.toLowerCase() !== frag;
    });

    const doneGames = allGames.filter((g) => g.done);
    // Narwhals-specific done games
    const ourDone = doneGames.filter((g) => {
      // result non-null means we were involved
      return g.result !== null;
    });
    const wins     = ourDone.filter((g) => g.result === "W").length;
    const losses   = ourDone.filter((g) => g.result === "L").length;
    const goalDiff = ourDone.reduce((acc, g) => {
      const s = g.sets[0];
      return acc + (s ? s.us - s.them : 0);
    }, 0);

    // Next and live game
    const upcoming = allGames
      .filter((g) => !g.done && g.timeISO && g.result === null)
      .sort((a, b) => new Date(a.timeISO) - new Date(b.timeISO));
    const nextGame  = upcoming[0] || null;
    const liveGame  = null; // TourneyMachine has no real-time live data

    const isOver    = allGames.length > 0 && allGames.every((g) => g.done);
    const isLive    = false;

    // Parse start/end dates from tournament.dates (e.g. "August 10–12, 2025")
    let startDate = null;
    let endDate   = null;
    if (tournament.dates) {
      const dateTexts = allGames
        .filter((g) => g.timeISO)
        .map((g) => new Date(g.timeISO).getTime())
        .filter(Boolean)
        .sort((a, b) => a - b);
      if (dateTexts.length > 0) {
        startDate = new Date(dateTexts[0]).toISOString().slice(0, 10);
        endDate   = new Date(dateTexts[dateTexts.length - 1]).toISOString().slice(0, 10);
      }
    }

    const pollSchedule = computePollSchedule(allGames);

    const payload = {
      teamName:             teamName,
      teamId:               "",
      tournamentId:         String(tournamentId),
      event: {
        id:        String(tournamentId),
        name:      tournament.name,
        location:  tournament.location,
        startDate,
        endDate,
        isOver,
      },
      record:               { wins, losses },
      goalDiff,
      games:                allGames,
      standings:            [],
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
      _dataSource:          "sportsengine",
      _tournamentName:      tournament.name,
      _divisions:           tournament.divisions,
      _pollSchedule:        pollSchedule,
    };

    _cache     = payload;
    _fetchedAt = now;
    _cacheKey  = cacheKey;

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.status(200).json(payload);

  } catch (err) {
    console.error("[sportsengine] fetch error:", err.message);
    if (_cache && _cacheKey === cacheKey) {
      return res.status(200).json({ ..._cache, cached: true, _stale: true, _staleError: String(err.message) });
    }
    return res.status(502).json({ error: "sportsengine_fetch_failed", detail: String(err.message) });
  }
}
