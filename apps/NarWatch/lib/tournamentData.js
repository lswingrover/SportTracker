// Static tournament data for NarWatch. v1 has no live data source —
// the API reads from this file. Future versions can swap in a live data
// source (e.g., a water-polo scoring system) by replacing the lookup
// function or adding a `dataSource: "api"` branch in /api/tournament.

export const TOURNAMENTS = [
  {
    id: "bend-2026",
    label: "Cascade Classic",
    chipLabel: "Bend",
    shortLabel: "Bend",
    teamId: "narwhals",
    teamName: "North Idaho Narwhals",
    venue: {
      name: "Bend Aquatic Center",
      address: "Bend, OR",
      tz: "America/Los_Angeles",
    },
    date: "Apr 17–19, 2026",
    static: true,
    dataSource: "niwp",
    weekKey: "2026-W16",
    record: { wins: 4, losses: 0 },
    games: [
      {
        id: "bend-2026-g1",
        done: true,
        result: "W",
        score: "13–3",
        sets: [{ us: 13, them: 3 }],
        opponent: "Bend Gold",
        court: "Cascade Classic",
        gameLabel: "Game 1",
        timeISO: "2026-04-18T01:30:00.000Z",
        isBracket: false,
      },
      {
        id: "bend-2026-g2",
        done: true,
        result: "W",
        score: "8–7",
        sets: [{ us: 8, them: 7 }],
        opponent: "Bend Black",
        court: "Cascade Classic",
        gameLabel: "Game 2",
        time: "Sat, Apr 18, 10:20 AM",
        isBracket: false,
      },
      {
        id: "bend-2026-g3",
        done: true,
        result: "W",
        score: "11–3",
        sets: [{ us: 11, them: 3 }],
        opponent: "TBD", // TODO: fill in actual opponent
        court: "Cascade Classic",
        gameLabel: "Game 3",
        timeISO: "2026-04-18T19:00:00.000Z",
        time: "Sat, Apr 18, 12:00 PM",
        isBracket: false,
      },
      {
        id: "bend-2026-g4",
        done: true,
        result: "W",
        score: null, // TODO: fill in actual score
        sets: [],
        opponent: "Eugene",
        court: "Cascade Classic",
        gameLabel: "Game 4",
        time: "Sun, Apr 19, 12:00 AM",
        isBracket: false,
      },
    ],
  },
  {
    id: "trident-cup-2026",
    label: "Trident Cup Invitational",
    chipLabel: "Orlando",
    shortLabel: "Orlando",
    teamId: "narwhals",
    teamName: "North Idaho Narwhals",
    venue: {
      name: "Rosen Aquatic Center",
      address: "8422 International Dr, Orlando, FL 32819",
      tz: "America/New_York",
    },
    date: "May 15–17, 2026",
    static: true,
    dataSource: "niwp",
    weekKey: "2026-W20",
    scoresUrl: "/api/trident-scores",
    // Pool N (3 teams, round-robin): Team Orlando (1st), North Idaho (2nd), Next Level (3rd)
    // Bracket: 2nd-place seeds (2M, 2N, 2O) play a 3-team round-robin on Sat/Sun.
    // All times America/New_York (EDT = UTC-4).
    // NIWP merge overlays final scores automatically when API covers W20.
    games: [
      // ── Friday May 15 — Pool play ──────────────────────────────────────
      {
        id: "trident-2026-g8",
        done: true,
        result: "L",
        score: "8–17",
        sets: [{ us: 8, them: 17 }],
        opponent: "Team Orlando",
        court: "Pool 1 / Main",
        gameLabel: "Game 8",
        timeISO: "2026-05-15T22:15:00Z", // 6:15 PM EDT
        time: "Fri, May 15, 6:15 PM",
        isBracket: false,
      },
      // ── Saturday May 16 — Pool play ────────────────────────────────────
      {
        id: "trident-2026-g24",
        done: true,
        result: "W",
        score: "6–5",
        sets: [{ us: 6, them: 5 }],
        opponent: "Next Level",
        court: "Pool 1",
        gameLabel: "Game 24",
        timeISO: "2026-05-16T13:45:00Z", // 9:45 AM EDT
        time: "Sat, May 16, 9:45 AM",
        isBracket: false,
      },
      // ── Sunday May 17 — Bracket (2nd-seed round-robin, Game 62 + 74) ──
      // NI finished 2nd in Pool N. 2N plays 2M then 2O.
      {
        id: "trident-2026-bracket-2n-a",
        done: false,
        result: null,
        score: null,
        sets: [],
        opponent: "TBD",
        court: "Pool 1",
        gameLabel: "Bracket · Game 62",
        timeISO: "2026-05-17T11:55:00Z", // 7:55 AM EDT — 2M vs 2N
        time: "Sun, May 17, 7:55 AM",
        isBracket: true,
      },
      {
        id: "trident-2026-bracket-2n-b",
        done: false,
        result: null,
        score: null,
        sets: [],
        opponent: "TBD",
        court: "Pool 1",
        gameLabel: "Bracket · Game 74",
        timeISO: "2026-05-17T15:35:00Z", // 11:35 AM EDT — 2N vs 2O
        time: "Sun, May 17, 11:35 AM",
        isBracket: true,
      },
    ],
  },
];

export function findTournament(tournamentId) {
  return TOURNAMENTS.find((t) => t.id === tournamentId) || null;
}

// Derive the next upcoming game — shared by API route and client-side
// buildStaticPayload so both produce the same nextEvent shape.
export function computeNextEventFromGames(games) {
  if (!Array.isArray(games) || games.length === 0) return null;
  const now = Date.now();
  const upcoming = games
    .filter((g) => !g.done && g.timeISO && new Date(g.timeISO).getTime() > now)
    .sort((a, b) => new Date(a.timeISO).getTime() - new Date(b.timeISO).getTime());
  if (!upcoming.length) return null;
  const g = upcoming[0];
  return {
    kind:     "game",
    id:       g.id,
    opponent: g.isBracket ? "TBD (bracket)" : (g.opponent || "TBD"),
    court:    g.court || null,
    time:     g.time  || null,
    timeISO:  g.timeISO,
  };
}

// Sum goal differential across all completed games in a tournament.
// games[] uses the same shape as the live data layer would: each game
// has { result: "W" | "L" | null, sets: [{ us, them, deciding? }, ...] }
// where `sets` for water polo represents quarters.
export function computeGoalDiff(games) {
  if (!Array.isArray(games)) return 0;
  let diff = 0;
  for (const g of games) {
    if (!g.done || !Array.isArray(g.sets)) continue;
    for (const s of g.sets) {
      if (typeof s.us === "number" && typeof s.them === "number") {
        diff += s.us - s.them;
      }
    }
  }
  return diff;
}
