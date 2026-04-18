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
 * Cap:     MAX_ENTRIES per project. FIFO eviction of the oldest entries when
 *          exceeded (TUS-002). Without a cap, a single large-dataset upload
 *          grew the index linearly, and the per-file read-filter-stringify
 *          cost in `markComplete` dominated end-of-run throughput (O(N^2)
 *          serialize work across a run). The cap bounds the stored array,
 *          and the in-memory hot-path below bounds per-file CPU to O(1).
 *
 * In-memory hot path:
 *   Calling `markComplete` once per tus success in a Tier-4 run (7980 files)
 *   used to JSON.parse + filter + JSON.stringify a 300+ KB string on every
 *   call — the second-half throughput floor. We now keep a per-project Map
 *   mirror and flush to localStorage on a debounce + before page hide, so
 *   the hot path is O(1) and the heavy JSON work happens at most a handful
 *   of times during a large upload.
 */

const KEY_PREFIX = "ls-tus-completed-";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
// Flush the in-memory mirror back to localStorage at most this often. 1 s
// is the sweet spot: frequent enough that a mid-run reload loses at most a
// handful of completions (already-uploaded files will just re-check the
// server), infrequent enough that the 300 KB JSON.stringify cost is paid
// at most ~once per second instead of per file.
const FLUSH_DEBOUNCE_MS = 1000;

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

// --- In-memory mirror ------------------------------------------------------
// Map<projectId, Map<fingerprint, ts>>. Insertion order preserved, which is
// how we evict oldest on cap overflow. Lazily hydrated from localStorage on
// first access per project.
const memIndex = new Map();
const dirtyProjects = new Set();
let flushTimer = null;
// Module-scoped guard: the `pagehide` listener must be installed exactly
// once per tab for the life of the module, regardless of how many React
// mounts call into us. Re-registering on every mount would leak listeners
// across HMR / route remounts.
let _listenerRegistered = false;

function hydrate(projectId) {
  if (memIndex.has(projectId)) return memIndex.get(projectId);
  const m = new Map();
  if (hasStorage()) {
    for (const e of safeParse(localStorage.getItem(keyForProject(projectId)))) {
      if (e && typeof e.fp === "string" && typeof e.ts === "number") {
        m.set(e.fp, e.ts);
      }
    }
  }
  memIndex.set(projectId, m);
  return m;
}

/**
 * Synchronously write any pending in-memory deltas to localStorage and
 * cancel the pending debounce timer. Idempotent: safe to call any number
 * of times, and safe to call when nothing is dirty (in which case it
 * simply clears the timer if one is pending and returns).
 *
 * Exported so both the `pagehide` listener and any explicit shutdown path
 * (tests, future SPA navigation hooks) can force a flush.
 */
export function flushNow() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!hasStorage()) {
    // No storage available: clear dirty set so we don't keep "owing" a
    // flush that can never happen.
    dirtyProjects.clear();
    return;
  }
  if (dirtyProjects.size === 0) return;
  for (const pid of dirtyProjects) {
    const m = memIndex.get(pid);
    if (!m) continue;
    // Serialize in insertion order so FIFO eviction survives a reload.
    const arr = [];
    for (const [fp, ts] of m) arr.push({ fp, ts });
    if (!arr.length) {
      localStorage.removeItem(keyForProject(pid));
    } else {
      localStorage.setItem(keyForProject(pid), JSON.stringify(arr));
    }
  }
  dirtyProjects.clear();
}

// Module init: install the `pagehide` flush listener exactly once per tab.
// `pagehide` fires reliably on mobile, on tab close, and is bfcache-friendly
// (unlike `beforeunload`, which Safari mobile ignores and which blocks
// bfcache participation). This closes the TUS-004 window where a completion
// lands in the in-memory Map inside the 1 s debounce interval and a reload
// then drops it before it hits disk.
function ensurePagehideListener() {
  if (_listenerRegistered) return;
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", flushNow);
  _listenerRegistered = true;
}
ensurePagehideListener();

function scheduleFlush() {
  if (!hasStorage()) return;
  // Defensive: module init already ran, but if this module is evaluated in
  // an environment where `window` arrived late (SSR hydration edge cases),
  // make sure the listener is attached before any dirty writes accumulate.
  ensurePagehideListener();
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
}

// Exposed for tests — forces a synchronous flush of any pending writes.
// Kept as a separate export (in addition to `flushNow`) so existing test
// call sites keep working without churn.
export function _flushForTests() {
  flushNow();
}

// Exposed for tests — wipes in-memory state so a test can start fresh.
// Does NOT un-register the `pagehide` listener: that's module-scoped by
// design and is what _listenerRegisteredForTests() inspects.
export function _resetForTests() {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  memIndex.clear();
  dirtyProjects.clear();
}

// Exposed for tests — lets the suite assert the listener registration is
// a once-per-tab invariant rather than re-registering on every mount.
export function _listenerRegisteredForTests() {
  return _listenerRegistered;
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
 * Record a successfully-completed fingerprint for this project. Re-marking
 * the same fingerprint refreshes its timestamp AND moves it to the end of
 * the insertion order (MRU), which means the oldest true-unique entries are
 * evicted first when the per-project cap is hit.
 */
export function markComplete(projectId, fingerprint) {
  if (projectId == null || !fingerprint) return;
  const m = hydrate(projectId);
  // Map.delete + Map.set refreshes insertion position so the FIFO eviction
  // below operates as proper LRU-on-duplicate.
  if (m.has(fingerprint)) m.delete(fingerprint);
  m.set(fingerprint, Date.now());
  // Evict oldest entries above the cap. Map preserves insertion order, so
  // `keys().next()` is the oldest.
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
  dirtyProjects.add(projectId);
  scheduleFlush();
}

/**
 * True iff `fingerprint` appears in this project's completed index and has
 * not expired. Expired entries are treated as absent (TTL is enforced here
 * as well as in pruneExpired so a stale entry still can't cause a false
 * positive skip between prune calls).
 */
export function isDuplicate(projectId, fingerprint) {
  if (projectId == null || !fingerprint) return false;
  const m = hydrate(projectId);
  const ts = m.get(fingerprint);
  if (typeof ts !== "number") return false;
  if (Date.now() - ts >= TTL_MS) return false;
  return true;
}

/**
 * Walk every `ls-tus-completed-*` key in localStorage and drop entries older
 * than TTL_MS. Also removes keys that end up empty. Cheap — runs once per
 * Import-page mount (see Import.jsx). Intentionally project-agnostic so a user
 * with many projects doesn't accumulate stale keys forever if one project is
 * never reopened. Also repopulates the in-memory mirror so the next
 * markComplete/isDuplicate doesn't re-hydrate stale data.
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
    const pidStr = k.slice(KEY_PREFIX.length);
    const pid = /^\d+$/.test(pidStr) ? Number(pidStr) : pidStr;
    if (!fresh.length) {
      localStorage.removeItem(k);
      memIndex.delete(pid);
      dirtyProjects.delete(pid);
    } else if (fresh.length !== entries.length) {
      localStorage.setItem(k, JSON.stringify(fresh));
      // Invalidate the memory mirror so the next hit re-hydrates cleanly.
      memIndex.delete(pid);
    }
  }
}
