// Persistent tournament snapshots. Every fresh /api/tournament fetch for
// a tournament that's currently live (or wrapping up "today") writes a
// JSON snapshot to Vercel Blob, rate-limited to one write per 5 minutes.
// On tournament end (event.isOver flips true), a single "terminal"
// snapshot is written as the authoritative final record.
//
// Blob layout:
//   snapshots/{eventId}/{ISO-with-dashes}.json           — periodic
//   snapshots/{eventId}/terminal-{ISO-with-dashes}.json  — terminal (one)
//
// Two read endpoints consume this:
//   GET /api/snapshots?eventId=...   → list (most recent first) + terminal
//   GET /api/snapshot?eventId=...&ts=latest|terminal|<isoLike>
//
// All operations no-op silently when BLOB_READ_WRITE_TOKEN is unset.

import { blobConfigured } from "./blobStore.js";

let _blob = null;
async function getBlob() {
  if (_blob) return _blob;
  try {
    _blob = await import("@vercel/blob");
    return _blob;
  } catch {
    return null;
  }
}

function isoSafe(iso) {
  return iso.replace(/:/g, "-").replace(/\./g, "-");
}

function snapshotPathname(eventId, terminal = false) {
  const ts = isoSafe(new Date().toISOString());
  const prefix = terminal ? "terminal-" : "";
  return `snapshots/${eventId}/${prefix}${ts}.json`;
}

function buildSnapshotBody({ eventId, tournamentId, payload, terminal }) {
  return {
    schemaVersion: 1,
    tournamentId: tournamentId || null,
    eventId,
    fetchedAt: new Date().toISOString(),
    terminal: terminal === true,
    record: payload?.record || null,
    poolPosition: payload?.poolPosition || null,
    games: payload?.games || [],
    standings: payload?.standings || [],
    workAssignments: payload?.workAssignments || [],
    liveGame: payload?.liveGame || null,
    event: payload?.event || null,
  };
}

// Decide whether a snapshot is warranted right now.
// "Live" = AES is reporting a currently-in-progress match. "Today" = the
// event window covers right-now. Tournaments outside both windows skip.
function isInteresting(payload) {
  if (payload?.liveGame) return { live: true, today: true };
  const start = payload?.event?.startDate;
  const end = payload?.event?.endDate;
  const now = Date.now();
  if (start && end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    // 30-min pre-roll, 6-hour post-roll on the event window.
    if (now >= startMs - 30 * 60 * 1000 && now <= endMs + 6 * 60 * 60 * 1000) {
      return { live: false, today: true };
    }
  }
  return null;
}

export async function maybeSnapshot({ eventId, tournamentId, payload }) {
  if (!blobConfigured() || !eventId) return null;
  const blob = await getBlob();
  if (!blob) return null;

  const isOver = payload?.event?.isOver === true;
  let listing = null;
  try {
    listing = await blob.list({ prefix: `snapshots/${eventId}/` });
  } catch {
    return null;
  }
  const blobs = listing?.blobs || [];
  const hasTerminal = blobs.some((b) => b.pathname.includes("/terminal-"));

  // Terminal: write once when isOver flips, regardless of rate limit.
  if (isOver && !hasTerminal) {
    try {
      const path = snapshotPathname(eventId, true);
      const body = buildSnapshotBody({ eventId, tournamentId, payload, terminal: true });
      await blob.put(path, JSON.stringify(body), {
        access: "private",
        contentType: "application/json",
        allowOverwrite: false,
        addRandomSuffix: false,
        cacheControlMaxAge: 0,
      });
      return { written: "terminal", path };
    } catch (err) {
      // Silent failure; terminal write isn't load-bearing for the response.
      return { error: String(err?.message || err) };
    }
  }

  // Periodic: only if interesting, rate-limited to 5min.
  const flag = isInteresting(payload);
  if (!flag) return null;

  const sorted = blobs
    .filter((b) => !b.pathname.includes("/terminal-"))
    .sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  const mostRecent = sorted[0];
  if (mostRecent && new Date(mostRecent.uploadedAt).getTime() > Date.now() - 5 * 60 * 1000) {
    return null;
  }

  try {
    const path = snapshotPathname(eventId, false);
    const body = buildSnapshotBody({ eventId, tournamentId, payload, terminal: false });
    await blob.put(path, JSON.stringify(body), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: false,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
    return { written: "periodic", path, ...flag };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

export async function listSnapshots(eventId) {
  if (!blobConfigured() || !eventId) return { count: 0, snapshots: [], terminal: null };
  const blob = await getBlob();
  if (!blob) return { count: 0, snapshots: [], terminal: null };
  let listing;
  try {
    listing = await blob.list({ prefix: `snapshots/${eventId}/` });
  } catch {
    return { count: 0, snapshots: [], terminal: null };
  }
  const items = (listing?.blobs || []).map((b) => ({
    pathname: b.pathname,
    uploadedAt: b.uploadedAt,
    size: b.size,
    terminal: b.pathname.includes("/terminal-"),
  }));
  items.sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  const terminal = items.find((i) => i.terminal) || null;
  return { count: items.length, snapshots: items, terminal };
}

export async function getSnapshot(eventId, ts) {
  if (!blobConfigured() || !eventId) return null;
  const blob = await getBlob();
  if (!blob) return null;
  let listing;
  try {
    listing = await blob.list({ prefix: `snapshots/${eventId}/` });
  } catch {
    return null;
  }
  const items = (listing?.blobs || []).slice().sort(
    (a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || "")
  );
  let target = null;
  if (!ts || ts === "latest") {
    target = items.find((b) => !b.pathname.includes("/terminal-")) || items[0];
  } else if (ts === "terminal") {
    target = items.find((b) => b.pathname.includes("/terminal-"));
  } else {
    target = items.find((b) => b.pathname.includes(ts));
  }
  if (!target) return null;
  try {
    const result = await blob.get(target.pathname, { access: "private" });
    if (!result?.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}
