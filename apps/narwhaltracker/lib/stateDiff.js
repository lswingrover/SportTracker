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
import { pushToTeam, pushToSubscribers, pushConfigured, prefValue } from "./push.js";

const subsKey = (teamId) => `push-subs-${teamId}.json`;
const stateKey = (eventId, teamId) => `state-${eventId}-${teamId}.json`;

const SCORE_PUSH_THROTTLE_MS = 60 * 1000;
const SOON_OBSERVATION_WINDOW_MIN = 5;

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

  // Load subscribers once so timing-aware events can bucket by leadMinutes.
  const allSubs = (await readJson(subsKey(teamId), { subs: [] }))?.subs || [];
  const subBuckets = (kind) => {
    const enabled = allSubs.filter((s) => prefValue(s.prefs, kind).enabled);
    const map = new Map();
    for (const s of enabled) {
      const lead = prefValue(s.prefs, kind).leadMinutes;
      if (!map.has(lead)) map.set(lead, []);
      map.get(lead).push(s);
    }
    return map;
  };

  const prevGames = new Map((prev.games || []).map((g) => [String(g.id), g]));
  const now = Date.now();
  const gameSoonBuckets = subBuckets("game-soon");
  const workSoonBuckets = subBuckets("work-soon");

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
          kind: "final-result",
          payload: {
            title: g.result === "W" ? `✅ ${teamName} WON` : `❌ ${teamName} lost`,
            body: `vs ${g.opponent}${g.score ? ` · ${g.score}` : ""} · Court ${g.court}`,
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
            kind: "schedule-change",
            payload: {
              title: `⚠️ Court change`,
              body: `vs ${g.opponent} moved from Court ${old.court} → Court ${g.court}`,
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
            kind: "schedule-change",
            payload: {
              title: `⚠️ Schedule change`,
              body: `vs ${g.opponent} now ${t} · Court ${g.court}`,
              tag: `time-${id}`,
            },
          });
        }
      }
    }

    // 2. "Game soon" pushes — bucket subscribers by their per-user
    //    leadMinutes choice. Each (game, leadBucket) pair fires once.
    if (!g.done && g.timeISO && gameSoonBuckets.size > 0) {
      const startMs = new Date(g.timeISO).getTime();
      const minsUntil = Math.round((startMs - now) / 60000);
      for (const [lead, bucketSubs] of gameSoonBuckets) {
        if (minsUntil <= lead && minsUntil > lead - SOON_OBSERVATION_WINDOW_MIN) {
          const evtKey = `gamesoon:${id}:${lead}`;
          if (!sent.has(evtKey)) {
            events.push({
              key: evtKey,
              subs: bucketSubs,
              payload: {
                title: `🏐 ${teamName} vs ${g.opponent} in ${lead} min`,
                body: `Court ${g.court}${g.time ? ` · ${g.time}` : ""}`,
                tag: `gamesoon-${id}-${lead}`,
              },
            });
          }
        }
      }
    }
  }

  // 2b. Work-duty "soon" pushes — same per-subscriber bucketing as games.
  if (workSoonBuckets.size > 0) {
    for (const w of payload.workAssignments || []) {
      if (!w.timeISO) continue;
      const startMs = new Date(w.timeISO).getTime();
      const minsUntil = Math.round((startMs - now) / 60000);
      for (const [lead, bucketSubs] of workSoonBuckets) {
        if (minsUntil <= lead && minsUntil > lead - SOON_OBSERVATION_WINDOW_MIN) {
          const evtKey = `worksoon:${w.id}:${lead}`;
          if (!sent.has(evtKey)) {
            events.push({
              key: evtKey,
              subs: bucketSubs,
              payload: {
                title: `🟡 Duty in ${lead} min`,
                body: `${w.role} at Court ${w.court}${w.teams ? ` · ${w.teams}` : ""}`,
                tag: `worksoon-${w.id}-${lead}`,
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
        kind: "live-score",
        payload: {
          title: `📊 Set ${live.setNumber} · ${live.us}–${live.them}`,
          body: `${teamName} ${lead} ${live.opponent} · Court ${live.court}`,
          tag: `score-${live.gameId}`,
        },
      });
      nextLastScorePushAt = now;
    }
  }

  // Send + record. Events with `subs` go to a pre-bucketed list (timing-
  // aware kinds); others route through pushToTeam(...) which filters by
  // prefs[kind].enabled at send time.
  //
  // NOTE: live-score events are intentionally NOT added to `sentEvents`.
  // Their dedup is handled entirely by two independent guards:
  //   1. liveSig check — only fires when rawSets actually changed.
  //   2. SCORE_PUSH_THROTTLE_MS — 60s minimum between live pushes.
  // Adding timestamp-unique score keys (score:${gameId}:${now}) to sentEvents
  // would exhaust the 200-slot cap and evict permanent result/court/time keys,
  // causing final-result notifications to re-fire on every poll.
  const fanouts = [];
  for (const evt of events) {
    if (evt.kind !== "live-score") {
      sent.add(evt.key);
    }
    if (Array.isArray(evt.subs)) {
      fanouts.push(pushToSubscribers(teamId, evt.subs, evt.payload));
    } else {
      fanouts.push(pushToTeam(teamId, evt.payload, evt.kind));
    }
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
