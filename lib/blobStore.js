// Tiny JSON-blob KV layered on top of @vercel/blob.
// Used as a stand-in for Vercel KV (which can't be provisioned via CLI).
// Each "key" is a pathname inside the linked Vercel Blob store.
//
// Push subscription endpoints + tournament-state diffs are sensitive, so
// we use access:"private" — only authed reads via @vercel/blob.get() work,
// the URLs cannot be fetched directly.
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

export async function readJson(pathname, fallback = null) {
  if (!blobConfigured()) return fallback;
  const blob = await getBlob();
  if (!blob) return fallback;
  try {
    const result = await blob.get(pathname, { access: "private" });
    if (!result) return fallback;
    // result.stream() or result.blob().text() depending on runtime
    const buf = await new Response(result.stream).arrayBuffer();
    const text = new TextDecoder().decode(buf);
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (err) {
    // BlobNotFoundError is expected on first run for any key; treat as fallback.
    if (err?.name === "BlobNotFoundError") return fallback;
    return fallback;
  }
}

export async function writeJson(pathname, value) {
  if (!blobConfigured()) return false;
  const blob = await getBlob();
  if (!blob) return false;
  try {
    await blob.put(pathname, JSON.stringify(value), {
      access: "private",
      contentType: "application/json",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
    return true;
  } catch (err) {
    console.error("[blobStore] writeJson failed:", err?.message || err);
    return false;
  }
}

export async function deleteJson(pathname) {
  if (!blobConfigured()) return false;
  const blob = await getBlob();
  if (!blob) return false;
  try {
    await blob.del(pathname);
    return true;
  } catch {
    return false;
  }
}
