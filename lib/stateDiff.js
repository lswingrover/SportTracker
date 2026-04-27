// State-diff between successive /api/tournament responses, persisted to a
// per-(eventId, teamId) Blob so it survives between serverless invocations.
//
// Rules of the road:
//   - Idempotency keys go in `sentEvents` so concurrent /api/tournament hits
//     don't emit the same notification twice. Once an event id is recorded
//     we never re-emit it, even if state cycles.
//   - Score-update pushes are rate-limited to 1/min per game.
//   - "Soon" pushes (30/10 min countdown) only fire when we observe the
//     transition into the window, which depends on the page being polled
//     at that moment; without a cron there's no other trigger.

import { readJson, writeJson } from "./blobStore.js";
import { pushToTeam, pushConfigured } from "./push.js";

const stateKey = (eventId, teamId) => `state-${eventId}-${teamId}.json`;

const SOON_LEADS_MIN = [30, 10];
const SCORE_PUSH_THROTTLE_MS = 60 * 1000;

function buildSentEventsLimit() {
  return 200; // cap to prevent unbounded blob growth
}

export async function diffAndPush({ eventId, teamId, teamName, payload }) {
  if (!pushConfigured()) return { skipped: "not_configured" };
  if (!eventId || !teamId) return { skipped: "missing_ids" };

  const key = stateKey(eventId, teamId);
  const prev = (await readJson(key, null)) || {
    games: [],
    liveSig: null,
    lastScorePushAt: 0,
    sentEvents: [],
  };

  const sent = new Set(prev.sentEvents || []);
  const events = [];

  const prevGames = new Map((prev.games || []).map((g) => [String(g.id), g]));
  const now = Date.now();

  // 1. Result, court, time changes per game.
  for (const g of payload.games || []) {
    const id = String(g.id);
    const old = prevGames.get(id);

    // Final result transition (was unknown, now known).
    if (g.result && (!old || !old.result)) {
      const evtKey = `result:${id}:${g.result}`;
      if (!sent.has(evtKey)) {
        events.push({
          key: evtKey,
          payload: {
            title: g.result === "W" ? `✅ ${teamName} WON` : `❌ ${teamName} lost`,
            body: `vs ${g.opponent}${g.score ? ` · ${g.score}` : ""} · Ct ${g.court}`,
            tag: `result-${id}`,
          },
        });
      }
    }

    if (old) {
      // Court change.
      if (g.court && old.court && g.court !== old.court) {
        const evtKey = `court:${id}:${g.court}`;
        if (!sent.has(evtKey)) {
          events.push({
            key: evtKey,
            payload: {
              title: `⚠️ Court change`,
              body: `vs ${g.opponent} moved from Ct ${old.court} → Ct ${g.court}`,
              tag: `court-${id}`,
            },
          });
        }
      }
      // Time change (only for upcoming games).
      if (!g.done && g.timeISO && old.timeISO && g.timeISO !== old.timeISO) {
        const evtKey = `time:${id}:${g.timeISO}`;
        if (!sent.has(evtKey)) {
          const t = new Date(g.timeISO).toLocaleString("en-US", {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          });
          events.push({
            key: evtKey,
            payload: {
              title: `⚠️ Schedule change`,
              body: `vs ${g.opponent} now ${t} · Ct ${g.court}`,
              tag: `time-${id}`,
            },
          });
        }
      }
    }

    // 2. "Soon" pushes (30 min, 10 min) — only for upcoming.
    if (!g.done && g.timeISO) {
      const startMs = new Date(g.timeISO).getTime();
      const minsUntil = Math.round((startMs - now) / 60000);
      for (const lead of SOON_LEADS_MIN) {
        if (minsUntil <= lead && minsUntil > lead - 5) {
          const evtKey = `soon:${id}:${lead}`;
          if (!sent.has(evtKey)) {
            events.push({
              key: evtKey,
              payload: {
                title: `🏐 ${teamName} vs ${g.opponent} in ${lead} min`,
                body: `Ct ${g.court}${g.time ? ` · ${g.time}` : ""}`,
                tag: `soon-${id}-${lead}`,
              },
            });
          }
        }
      }
    }
  }

  // 3. Live score updates (throttled).
  let nextLiveSig = prev.liveSig || null;
  let nextLastScorePushAt = prev.lastScorePushAt || 0;
  if (payload.liveGame) {
    const live = payload.liveGame;
    const sig = JSON.stringify(live.rawSets || []);
    nextLiveSig = sig;
    if (
      sig !== (prev.liveSig || null) &&
      now - (prev.lastScorePushAt || 0) > SCORE_PUSH_THROTTLE_MS
    ) {
      const lead = live.us > live.them ? "leads" : live.us < live.them ? "trails" : "tied with";
      events.push({
        key: `score:${live.gameId}:${now}`,
        payload: {
          title: `📊 Set ${live.setNumber} · ${live.us}–${live.them}`,
          body: `${teamName} ${lead} ${live.opponent} · Ct ${live.court}`,
          tag: `score-${live.gameId}`,
        },
      });
      nextLastScorePushAt = now;
    }
  }

  // Send + record.
  const fanouts = [];
  for (const evt of events) {
    sent.add(evt.key);
    fanouts.push(pushToTeam(teamId, evt.payload));
  }

  // Persist new state BEFORE awaiting fanouts so concurrent invocations
  // see the recorded event ids and don't double-fire.
  const trimmedSent = Array.from(sent).slice(-buildSentEventsLimit());
  const nextGames = (payload.games || []).map((g) => ({
    id: g.id,
    result: g.result,
    court: g.court,
    timeISO: g.timeISO,
    done: g.done,
  }));
  await writeJson(key, {
    games: nextGames,
    liveSig: nextLiveSig,
    lastScorePushAt: nextLastScorePushAt,
    sentEvents: trimmedSent,
    updatedAt: new Date().toISOString(),
  });

  await Promise.allSettled(fanouts);
  return { events: events.length, total: payload.games?.length || 0 };
}
