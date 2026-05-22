// Hillsboro Scrimmage Games schedule API.
//
// Sheet: https://docs.google.com/spreadsheets/d/1Vz4ukRB7KyVSv-15yfi0vA9zTwxDKlMON9xUKb3PhdQ
// Dates: Thu May 21 + Sat May 23, 2026
//
// Attempts a live CSV export from the sheet (works if "anyone with link can view"
// is set). Falls back to the hardcoded schedule below if the fetch fails or times out.
//
// Note: this is a scrimmage schedule — scores are not tracked in the sheet.
// The response flags `scrimmage: true` so the UI can handle the no-scores case.

const SHEET_ID   = '1Vz4ukRB7KyVSv-15yfi0vA9zTwxDKlMON9xUKb3PhdQ';
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

// Full known schedule parsed from the sheet (2026-05-21 and 2026-05-23).
// Columns: game number, time, pool, team1, team2 (team1 is always listed first / dark).
// Times are Pacific (PDT, UTC-7). Stored as ISO-ish local strings.
const HARDCODED_SCHEDULE = [
  // ── THURSDAY May 21, 2026 ──────────────────────────────────────────────────
  { game: 1,  date: '2026-05-21', time: '18:30', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Thursday' },
  { game: 2,  date: '2026-05-21', time: '18:30', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Thursday' },
  { game: 3,  date: '2026-05-21', time: '19:20', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Thursday' },
  { game: 4,  date: '2026-05-21', time: '19:20', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Thursday' },
  { game: 5,  date: '2026-05-21', time: '20:10', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Thursday' },
  { game: 6,  date: '2026-05-21', time: '20:10', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Thursday' },
  { game: 7,  date: '2026-05-21', time: '21:00', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Thursday' },
  { game: 8,  date: '2026-05-21', time: '21:00', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Thursday' },
  // ── SATURDAY May 23, 2026 ─────────────────────────────────────────────────
  { game: 9,  date: '2026-05-23', time: '07:30', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
  { game: 10, date: '2026-05-23', time: '07:30', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 11, date: '2026-05-23', time: '08:25', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 12, date: '2026-05-23', time: '08:25', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
  { game: 13, date: '2026-05-23', time: '09:20', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 14, date: '2026-05-23', time: '09:20', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
  { game: 15, date: '2026-05-23', time: '10:15', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 16, date: '2026-05-23', time: '10:15', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
  { game: 17, date: '2026-05-23', time: '11:10', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 18, date: '2026-05-23', time: '11:10', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
  { game: 19, date: '2026-05-23', time: '12:05', pool: null, team1: 'CDA 18B',   team2: 'HB18B',       day: 'Saturday' },
  { game: 20, date: '2026-05-23', time: '12:05', pool: null, team1: 'CDA 18G',   team2: 'HB18G',       day: 'Saturday' },
];

// Which teams are CDA / NI (for highlighting "our games").
const CDA_PATTERN = /\bCDA\b|\bNIWP\b|\bnarwhal/i;
// Which specific team is "the" 18U Boys for filtering.
const BOYS_PATTERN = /18[Uu]\s*B(?:oy|$)/;

function isCdaTeam(name) {
  return CDA_PATTERN.test(name);
}

function tagGame(g) {
  const ourTeam = isCdaTeam(g.team1) ? g.team1 : (isCdaTeam(g.team2) ? g.team2 : null);
  const opponent = ourTeam === g.team1 ? g.team2 : g.team1;
  const isBoys = BOYS_PATTERN.test(g.team1) || BOYS_PATTERN.test(g.team2);
  return {
    game:     g.game,
    date:     g.date,
    time:     g.time,
    day:      g.day,
    team1:    g.team1,
    team2:    g.team2,
    our_team: ourTeam,
    opponent,
    is_boys:  isBoys,
    scrimmage: true,
  };
}

async function tryFetchSchedule() {
  try {
    const res = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const text = await res.text();
    // Very basic parse — just return raw CSV for now; the hardcoded fallback is
    // more reliable for display. If the sheet adds scores later, parse here.
    if (text.trim().length < 20) return null;
    return { raw_csv: text, source: 'live' };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional filter: ?team=boys or ?team=girls or ?day=thursday|saturday
  const teamFilter = (req.query.team || '').toLowerCase();
  const dayFilter  = (req.query.day  || '').toLowerCase();

  // Try live sheet; ignore result for now (no scores to pull yet).
  await tryFetchSchedule();

  let games = HARDCODED_SCHEDULE.map(tagGame);

  if (teamFilter === 'boys') {
    games = games.filter(g => g.is_boys);
  } else if (teamFilter === 'girls') {
    games = games.filter(g => !g.is_boys);
  }

  if (dayFilter === 'thursday') {
    games = games.filter(g => g.day === 'Thursday');
  } else if (dayFilter === 'saturday') {
    games = games.filter(g => g.day === 'Saturday');
  }

  // Summarize by day for convenience.
  const byDay = {};
  for (const g of games) {
    if (!byDay[g.day]) byDay[g.day] = [];
    byDay[g.day].push(g);
  }

  res.status(200).json({
    tournament: 'CDA-Hillsboro Scrimmage Games',
    dates:      ['2026-05-21', '2026-05-23'],
    scrimmage:  true,
    source:     'hardcoded',
    sheet_id:   SHEET_ID,
    games_total: games.length,
    games,
    by_day: byDay,
  });
}
