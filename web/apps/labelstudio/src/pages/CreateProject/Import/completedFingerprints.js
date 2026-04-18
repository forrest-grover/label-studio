/**
 * Per-project "completed upload" fingerprint index kept in localStorage.
 *
 * Complements tus-js-client's own `removeFingerprintOnSuccess: true` (see
 * tusUpload.js:59). tus wipes its fingerprint-to-uploadURL entry the moment a
 * file finalizes — which is what we want for freeing up storage — but it also
 * means that after a reload the client can't tell a freshly-dropped file from
 * one that already finished earlier in the same session. Without this index a
 * user who reloads mid-batch and re-drops the same file set re-uploads every
 * already-completed file, producing duplicate FileUpload rows on the server
 * (TUS-001).
 *
 * Shape:   localStorage[`ls-tus-completed-<projectId>`] = [{ fp, ts }, ...]
 * Key:     `${name}:${size}:${lastModified}` — the ticket spec's dedup key.
 *          This is intentionally independent of tus-js-client's internal
 *          fingerprint format so we can compute it from a raw File at
 *          enqueue time without touching tus internals.
 * TTL:     7 days. `pruneExpired` walks every `ls-tus-completed-*` key and
 *          evicts stale entries; called once per Import-page mount.
 */

const KEY_PREFIX = "ls-tus-completed-";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function keyForProject(projectId) {
  return `${KEY_PREFIX}${projectId}`;
}

function hasStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function safeParse(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function readEntries(projectId) {
  if (!hasStorage()) return [];
  return safeParse(localStorage.getItem(keyForProject(projectId)));
}

function writeEntries(projectId, entries) {
  if (!hasStorage()) return;
  if (!entries.length) {
    localStorage.removeItem(keyForProject(projectId));
  } else {
    localStorage.setItem(keyForProject(projectId), JSON.stringify(entries));
  }
}

/**
 * Compute the dedup fingerprint for a File. Exported so callers don't need to
 * duplicate the formula (and so there's one place to change it if needed).
 */
export function fingerprintForFile(file) {
  // `lastModified` is part of the W3C File interface; falls back to 0 for the
  // rare File-like object that omits it (some drag-drop synthetic payloads).
  const lm = typeof file?.lastModified === "number" ? file.lastModified : 0;
  return `${file?.name ?? ""}:${file?.size ?? 0}:${lm}`;
}

/**
 * Record a successfully-completed fingerprint for this project. Dedups on fp
 * so re-recording the same upload just refreshes its timestamp.
 */
export function markComplete(projectId, fingerprint) {
  if (projectId == null || !fingerprint) return;
  const entries = readEntries(projectId).filter((e) => e.fp !== fingerprint);
  entries.push({ fp: fingerprint, ts: Date.now() });
  writeEntries(projectId, entries);
}

/**
 * True iff `fingerprint` appears in this project's completed index and has
 * not expired. Expired entries are treated as absent (TTL is enforced here
 * as well as in pruneExpired so a stale entry still can't cause a false
 * positive skip between prune calls).
 */
export function isDuplicate(projectId, fingerprint) {
  if (projectId == null || !fingerprint) return false;
  const now = Date.now();
  const entries = readEntries(projectId);
  for (const e of entries) {
    if (e.fp === fingerprint && now - (e.ts || 0) < TTL_MS) return true;
  }
  return false;
}

/**
 * Walk every `ls-tus-completed-*` key in localStorage and drop entries older
 * than TTL_MS. Also removes keys that end up empty. Cheap — runs once per
 * Import-page mount (see Import.jsx). Intentionally project-agnostic so a user
 * with many projects doesn't accumulate stale keys forever if one project is
 * never reopened.
 */
export function pruneExpired() {
  if (!hasStorage()) return;
  const now = Date.now();
  const keysToScan = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) keysToScan.push(k);
  }
  for (const k of keysToScan) {
    const entries = safeParse(localStorage.getItem(k));
    const fresh = entries.filter((e) => e && typeof e.ts === "number" && now - e.ts < TTL_MS);
    if (!fresh.length) {
      localStorage.removeItem(k);
    } else if (fresh.length !== entries.length) {
      localStorage.setItem(k, JSON.stringify(fresh));
    }
  }
}
