// Static Hudl Fan broadcast map for 208 VBC U14 RED — 2025-26 season.
// Org: 192465 (208 Volleyball, Post Falls ID)   Team: 921788 (U14 RED)
//
// HOW TO UPDATE: After each tournament, open the Hudl Fan team page in
// Chrome and run this in DevTools console:
//   [...document.querySelectorAll('a[href*="/watch?b="]')]
//     .map(a => ({ b: new URL(a.href).searchParams.get('b'), text: a.innerText?.trim() }))
// Then add new entries below in chronological order (newest first within each tournament).

export const HUDL_TEAM_URL = "https://www.hudl.com/team/v2/921788/fan";
export const HUDL_WATCH_BASE = `${HUDL_TEAM_URL}/watch?b=`;

// Each entry: { broadcastId, opponent, date, tournament }
//   broadcastId : base64 string from the ?b= param (store decoded form)
//   opponent    : as shown on Hudl Fan card — used for fuzzy match against AES opponent
//   date        : YYYY-MM-DD (local tournament date)
//   tournament  : VolleyWatch tournament slug (matches the chip id in index.jsx)
export const HUDL_BROADCASTS = [
  // Big Sky VolleyFest 2026 — May 2-3, Billings MT
  { broadcastId: "QnJvYWRjYXN0NDAwNDY2Mw==", opponent: "Big Sky 14-3",       date: "2026-05-02", tournament: "big-sky-volleyfest-2026" },
  { broadcastId: "QnJvYWRjYXN0NDAwNDY3Mg==", opponent: "Avalanche 14 White", date: "2026-05-02", tournament: "big-sky-volleyfest-2026" },
  { broadcastId: "QnJvYWRjYXN0NDAwNDY3Nw==", opponent: "Aces 14U",           date: "2026-05-02", tournament: "big-sky-volleyfest-2026" },
  { broadcastId: "QnJvYWRjYXN0NDAwNjAxMA==", opponent: "BHJ 14 Green", date: "2026-05-03", tournament: "big-sky-volleyfest-2026" },

  // ERVA Regional 2026 — April 25-26
  { broadcastId: "QnJvYWRjYXN0Mzk4NjEyOA==", opponent: "ERVA-Club Selah 14",     date: "2026-04-26", tournament: "erva-regional-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk4NTk5Nw==", opponent: "ERVA-Yakima 14",         date: "2026-04-26", tournament: "erva-regional-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk4MzI4OQ==", opponent: "ERVA-CPA 14",            date: "2026-04-25", tournament: "erva-regional-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk4MzIyNQ==", opponent: "ERVA-SVVC",              date: "2026-04-25", tournament: "erva-regional-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk4MjEzOQ==", opponent: "ERVA-Ambition 13 Power", date: "2026-04-25", tournament: "erva-regional-2026" },

  // ERVA Power League 2026
  { broadcastId: "QnJvYWRjYXN0Mzk1OTEwMw==", opponent: "Riptide U14",         date: "2026-04-18", tournament: "erva-power-league-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk1ODY0OA==", opponent: "Kahila U14 Silver",   date: "2026-04-18", tournament: "erva-power-league-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk1NjEzOQ==", opponent: "Shockwave U14 White", date: "2026-04-18", tournament: "erva-power-league-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzk1NjEzMQ==", opponent: "SVVC 14 Black",       date: "2026-04-18", tournament: "erva-power-league-2026" },

  // MT NW Jamboree 2026 — March 28
  { broadcastId: "QnJvYWRjYXN0Mzg4NTM5Nw==", opponent: "Ignite U13 Aqua",    date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg4NTExMA==", opponent: "Ambition 14 Elite",  date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg4NDUwNw==", opponent: "208 VBC Warmup",     date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg4Mzk4OA==", opponent: "MVA 14 National",    date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg4MjQ3MA==", opponent: "MT NW 14 Elite",     date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg4MjM2NQ==", opponent: "U14 Ignite Valley",  date: "2026-03-28", tournament: "mt-nw-jamboree-2026" },

  // Sandpoint Showdown 2026 — March 21
  { broadcastId: "QnJvYWRjYXN0Mzg1ODIwOQ==", opponent: "208 U14 Spokane", date: "2026-03-21", tournament: "sandpoint-showdown-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg1NzkxOQ==", opponent: "208 U13 Blue",    date: "2026-03-21", tournament: "sandpoint-showdown-2026" },
  { broadcastId: "QnJvYWRjYXN0Mzg1NTEzNg==", opponent: "NVC 14-Snowpack", date: "2026-03-21", tournament: "sandpoint-showdown-2026" },

  // Holly Jolly Jamboree 2025 — Feb 28 (date AES uses)
  { broadcastId: "QnJvYWRjYXN0Mzc3MjUzMg==", opponent: "extreme U13",       date: "2026-02-28", tournament: "holly-jolly-jamboree-2025" },
  { broadcastId: "QnJvYWRjYXN0Mzc3MjA2OA==", opponent: "208 U13 Blue",      date: "2026-02-28", tournament: "holly-jolly-jamboree-2025" },
  { broadcastId: "QnJvYWRjYXN0Mzc2ODYzMA==", opponent: "Ambition 14 Elite", date: "2026-02-28", tournament: "holly-jolly-jamboree-2025" },
  { broadcastId: "QnJvYWRjYXN0Mzc2ODU3OQ==", opponent: "Kokua 12-1",        date: "2026-02-28", tournament: "holly-jolly-jamboree-2025" },
];

// Tournament game-day windows for the "Watch Live" banner heuristic.
// When today's date (in tournamentTimezone) matches a listed date AND the
// hour falls inside [GAME_HOUR_START, GAME_HOUR_END), teamWatchNowLink is
// populated. Hudl Fan is client-rendered, so we cannot detect actual LIVE
// state server-side — this date-window heuristic is the best we can do.
export const TOURNAMENT_WINDOWS = [
  { slug: "big-sky-volleyfest-2026",   dates: ["2026-05-02", "2026-05-03"], timezone: "America/Denver" },
  { slug: "erva-regional-2026",        dates: ["2026-04-25", "2026-04-26"], timezone: "America/Los_Angeles" },
  { slug: "erva-power-league-2026",    dates: ["2026-04-18", "2026-04-19", "2026-02-15"], timezone: "America/Los_Angeles" },
  { slug: "mt-nw-jamboree-2026",       dates: ["2026-03-28"], timezone: "America/Denver" },
  { slug: "sandpoint-showdown-2026",   dates: ["2026-03-21"], timezone: "America/Los_Angeles" },
  { slug: "holly-jolly-jamboree-2025", dates: ["2026-02-28"], timezone: "America/Los_Angeles" },
];

const GAME_HOUR_START = 7;
const GAME_HOUR_END = 19;

// AES eventId → VolleyWatch tournament slug (matches chip ids in index.jsx).
// Used by the API handler to derive a slug from request params without
// requiring callers to pass tournamentId explicitly.
export const AES_EVENT_TO_SLUG = {
  PTAwMDAwNDI5NjU90: "big-sky-volleyfest-2026",
  PTAwMDAwNDI2MDU90: "erva-regional-2026",
  PTAwMDAwNDQ5NzY90: "mt-nw-jamboree-2026",
  PTAwMDAwNDI2MDY90: "erva-power-league-2026",
};

export function slugFromEventId(eventId) {
  return AES_EVENT_TO_SLUG[String(eventId || "")] || null;
}

// Find the Hudl broadcast that best matches an AES opponent name.
// Returns { broadcastId, watchUrl } or null. Strategy: normalize both
// strings (lowercase, strip punctuation), then prefer exact match,
// then containment, then longest-common-substring ratio ≥0.45.
export function findBroadcast(opponentName, tournamentSlug) {
  if (!opponentName) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const needle = norm(opponentName);
  if (!needle) return null;

  const pool = tournamentSlug
    ? HUDL_BROADCASTS.filter((b) => b.tournament === tournamentSlug)
    : HUDL_BROADCASTS;

  let best = null;
  let bestScore = 0;
  for (const bc of pool) {
    const haystack = norm(bc.opponent);
    if (!haystack) continue;
    if (needle === haystack) return _result(bc);
    if (needle.includes(haystack) || haystack.includes(needle)) {
      const score = Math.min(needle.length, haystack.length) / Math.max(needle.length, haystack.length);
      if (score > bestScore) { bestScore = score; best = bc; }
      continue;
    }
    const lcs = _lcs(needle, haystack);
    const score = lcs / Math.max(needle.length, haystack.length);
    if (score > bestScore && score >= 0.45) { bestScore = score; best = bc; }
  }
  return best ? _result(best) : null;
}

// True when the current clock falls inside a known tournament game window.
// Used to populate teamWatchNowLink for the live banner.
export function isInTournamentWindow(tournamentSlug) {
  const win = TOURNAMENT_WINDOWS.find((w) => w.slug === tournamentSlug);
  if (!win) return false;
  const tz = win.timezone;
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const hour = parseInt(
    now.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
    10
  );
  return win.dates.includes(todayStr) && hour >= GAME_HOUR_START && hour < GAME_HOUR_END;
}

function _result(bc) {
  return {
    broadcastId: bc.broadcastId,
    watchUrl: HUDL_WATCH_BASE + encodeURIComponent(bc.broadcastId),
  };
}

function _lcs(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) len++;
      if (len > max) max = len;
    }
  }
  return max;
}
