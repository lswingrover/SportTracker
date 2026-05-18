// Tiny JSON-blob KV layered on top of @vercel/blob.
// Used as a stand-in for Vercel KV (which can't be provisioned via CLI).
// Each "key" is a pathname inside the linked Vercel Blob store.
//
// Storage model: public blobs (Vercel free/hobby plan compatible).
// "Public" here means the CDN URL is world-readable IF the caller
// knows the exact URL — no directory listing is exposed. Push
// subscription objects contain endpoint URLs and auth keys that are
// long random strings already exposed to the push service (FCM/APNs),
// so public storage is acceptable.
//
// All functions return null/false and never throw when BLOB_READ_WRITE_TOKEN
// is missing (e.g., local dev without `vercel env pull`). That keeps the rest
// of the app functional even when push infrastructure is unconfigured.

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

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Read a JSON blob by pathname.
// Uses blob.list() to find the blob URL (addRandomSuffix:false makes
// pathnames deterministic), then fetches it directly. Falls back to
// `fallback` on any error, including BlobNotFoundError on first run.
export async function readJson(pathname, fallback = null) {
  if (!blobConfigured()) return fallback;
  const blob = await getBlob();
  if (!blob) return fallback;
  try {
    const { blobs } = await blob.list({ prefix: pathname, limit: 1 });
    if (!blobs.length) return fallback;
    // Exact pathname match — list returns prefix matches, so confirm.
    const match = blobs.find((b) => b.pathname === pathname);
    if (!match) return fallback;
    const res = await fetch(match.url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

export async function writeJson(pathname, value) {
  if (!blobConfigured()) return false;
  const blob = await getBlob();
  if (!blob) return false;
  try {
    await blob.put(pathname, JSON.stringify(value), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    return true;
  } catch (err) {
    console.error("[blobStore] writeJson failed:", err?.message || err);
    return false;
  }
}

// Delete a JSON blob by pathname.
// Uses blob.list() to resolve the URL (same as readJson), then del().
export async function deleteJson(pathname) {
  if (!blobConfigured()) return false;
  const blob = await getBlob();
  if (!blob) return false;
  try {
    const { blobs } = await blob.list({ prefix: pathname, limit: 1 });
    const match = blobs.find((b) => b.pathname === pathname);
    if (!match) return true; // already gone
    await blob.del(match.url);
    return true;
  } catch {
    return false;
  }
}
