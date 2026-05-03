/**
 * NarWatch Smart Polling Scheduler
 *
 * Pure utility — no I/O, no side effects. Given a list of normalized game
 * objects (must have { timeISO }) and the current epoch-ms timestamp, returns
 * the appropriate polling interval and a mode label.
 *
 * WHY schedule-aware polling matters
 * ───────────────────────────────────
 * Stats are entered manually by the scorekeeper (Ryan Curry) via the NIWP
 * website after each game. Observed timing across 85 games:
 *   created_at ≈ 5–30 min BEFORE game_date   (game record pre-created)
 *   updated_at ≈ 45–75 min AFTER game_date   (stats entered post-game)
 *
 * So the "live window" — when a stat update is most likely to appear — is
 * game_date + 30 min through game_date + 90 min. Hammering the API outside
 * that window wastes bandwidth and adds no value. Between tournaments the
 * data changes at most once a day (if at all).
 *
 * MODES (checked in priority order):
 *
 *   live      game_date + 30m → + 90m    90 sec   ← highest update probability
 *   hot       game_date - 30m → + 30m    3 min    ← game starting / just ended
 *   cooldown  game_date + 90m → + 150m   5 min    ← tail of entry window
 *   warm      game day, between games    10 min   ← check if schedule changes
 *   cold      no games today             4 hours  ← background heartbeat
 *
 * @module lib/pollSchedule
 */

export const POLL_MODES = {
  live:     { label: 'live',     intervalMs:  90 * 1000,           desc: 'Live entry window — polling fast' },
  hot:      { label: 'hot',      intervalMs:   3 * 60 * 1000,     desc: 'Game start / end — polling hot' },
  cooldown: { label: 'cooldown', intervalMs:   5 * 60 * 1000,     desc: 'Post-game wind-down' },
  warm:     { label: 'warm',     intervalMs:  10 * 60 * 1000,     desc: 'Game day, between games' },
  cold:     { label: 'cold',     intervalMs: 240 * 60 * 1000,     desc: 'No games today' },
};

/**
 * Compute the current polling schedule given the game list.
 *
 * @param {Array<{ timeISO: string|null }>} games
 *   Normalized game objects. Only `timeISO` is required. Other fields ignored.
 * @param {number} [nowMs]  Current epoch ms. Defaults to Date.now().
 * @returns {{
 *   mode:           string,
 *   intervalMs:     number,
 *   label:          string,
 *   desc:           string,
 *   nextGameISO:    string|null,
 *   minsToNextGame: number|null,
 * }}
 */
export function computePollSchedule(games, nowMs = Date.now()) {
  if (!Array.isArray(games) || games.length === 0) {
    return { ...POLL_MODES.cold, mode: 'cold', nextGameISO: null, minsToNextGame: null };
  }

  // Build sorted list of games that have a parseable timeISO
  const timed = games
    .filter(g => g.timeISO)
    .map(g => {
      const t = new Date(g.timeISO).getTime();
      return isNaN(t) ? null : { timeISO: g.timeISO, _t: t };
    })
    .filter(Boolean)
    .sort((a, b) => a._t - b._t);

  if (timed.length === 0) {
    return { ...POLL_MODES.cold, mode: 'cold', nextGameISO: null, minsToNextGame: null };
  }

  // ── Check for an active game window ──────────────────────────────────────
  // Walk all games (newest first is fine) looking for one whose window
  // overlaps [now - 150min, now + 30min].
  for (const g of timed) {
    const minsFromNow = (nowMs - g._t) / 60000; // positive = game is in the past

    // Not yet in the window (game is more than 30 min away)
    if (minsFromNow < -30) continue;

    if (minsFromNow < 30) {
      // HOT: within 30 min of start OR within 30 min after start
      return {
        ...POLL_MODES.hot,
        mode: 'hot',
        nextGameISO: g.timeISO,
        minsToNextGame: minsFromNow < 0 ? Math.round(-minsFromNow) : 0,
      };
    }
    if (minsFromNow < 90) {
      // LIVE: 30–90 min after start — peak stat-entry window
      return {
        ...POLL_MODES.live,
        mode: 'live',
        nextGameISO: g.timeISO,
        minsToNextGame: null,
      };
    }
    if (minsFromNow < 150) {
      // COOLDOWN: 90–150 min after start — tail of entry window
      return {
        ...POLL_MODES.cooldown,
        mode: 'cooldown',
        nextGameISO: g.timeISO,
        minsToNextGame: null,
      };
    }
    // Beyond 150 min — this game is cold. Continue scanning for a later game.
  }

  // ── No active window. Is there a game today? ─────────────────────────────
  const sod = new Date(nowMs);
  sod.setHours(0, 0, 0, 0);
  const sodMs  = sod.getTime();
  const eodMs  = sodMs + 86_400_000;

  const todayGames = timed.filter(g => g._t >= sodMs && g._t < eodMs);
  if (todayGames.length > 0) {
    const next = todayGames.find(g => g._t > nowMs);
    return {
      ...POLL_MODES.warm,
      mode: 'warm',
      nextGameISO:    next?.timeISO ?? todayGames[0].timeISO,
      minsToNextGame: next ? Math.round((next._t - nowMs) / 60000) : null,
    };
  }

  // ── Cold — find the next upcoming game for display ────────────────────────
  const nextGame = timed.find(g => g._t > nowMs);
  return {
    ...POLL_MODES.cold,
    mode: 'cold',
    nextGameISO:    nextGame?.timeISO ?? null,
    minsToNextGame: nextGame ? Math.round((nextGame._t - nowMs) / 60000) : null,
  };
}
