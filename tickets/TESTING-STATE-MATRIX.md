# State coverage matrix for TUS-001..005

Scope: all code changed on branch `tus-upload` in commits 86617db, 6c9e4d3, dee9c2a,
f3c2acf, 3a8fbc7, 3b210d1, 6d20c3e.

Notation: "GAP" = no unit test directly targets this state. "INDIRECT" = covered
end-to-end by tier_resume.py or similar integration path but no unit test isolates
the state; still counted as GAP for unit coverage.

---

## 1. `completedFingerprints.js` — `fingerprintForFile`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-FP-1 | Normal File: name, size, lastModified all present | Returns `"<name>:<size>:<lastModified>"` | completedFingerprints.test.js: "fingerprintForFile uses <name>:<size>:<lastModified>" |
| CF-FP-2 | File-like with no `lastModified` property | Falls back to 0 | completedFingerprints.test.js: "fingerprintForFile falls back to 0 for missing lastModified" |
| CF-FP-3 | `lastModified` is present but is a non-number (e.g. string) | Falls back to 0 (typeof check) | GAP |
| CF-FP-4 | `file` is `null` or `undefined` | Returns `":0:0"` via optional-chaining fallback | GAP |
| CF-FP-5 | `file.name` is empty string | Returns `":${size}:${lm}"` | GAP |
| CF-FP-6 | `file.name` contains colons (e.g. `"foo:bar.png"`) | Includes extra colons; server parses same string | GAP — potential ambiguity: name contains the delimiter |

---

## 2. `completedFingerprints.js` — `markComplete`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-MC-1 | projectId valid, fingerprint non-empty, entry absent | Entry added to memIndex; dirtyProjects gets pid; debounce timer started | completedFingerprints.test.js: "markComplete then isDuplicate returns true…" (implicit) |
| CF-MC-2 | Same fingerprint marked again (re-mark) | Existing key deleted + re-inserted (MRU refresh); count stays 1 | completedFingerprints.test.js: "re-marking the same fingerprint refreshes its timestamp instead of appending" |
| CF-MC-3 | Re-mark of oldest entry prevents it from being evicted first | Oldest key moves to MRU end; next overflow evicts second-oldest | completedFingerprints.test.js: "re-marking an existing fingerprint moves it to MRU so it isn't evicted first" |
| CF-MC-4 | Exactly MAX_ENTRIES (5000) unique fingerprints marked | Size stays at 5000; no eviction yet | GAP — boundary at cap: only over-cap is tested |
| CF-MC-5 | MAX_ENTRIES + 1 unique fingerprints (one overflow) | Oldest entry evicted; size stays 5000 | completedFingerprints.test.js: "markComplete caps the per-project index and evicts the oldest entries (FIFO)" (tests +120 overflow) |
| CF-MC-6 | MAX_ENTRIES + large overflow (e.g. +1000) | Only exactly MAX_ENTRIES entries survive | Covered by existing cap test (uses +120) — at-cap boundary (exactly 5001st) is GAP |
| CF-MC-7 | `projectId == null` | Returns early; no memIndex entry | GAP |
| CF-MC-8 | `fingerprint` is empty string or falsy | Returns early | GAP |
| CF-MC-9 | `hasStorage()` returns false (no window) | scheduleFlush short-circuits; dirtyProjects gets entry but no timer set | GAP |
| CF-MC-10 | `hydrate` called for a project whose localStorage key is missing | Returns empty Map; memIndex populated with empty Map | GAP (indirect: covered by isDuplicate tests but not markComplete directly) |

---

## 3. `completedFingerprints.js` — `isDuplicate`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-ID-1 | Entry present, within TTL | Returns true | completedFingerprints.test.js: "markComplete then isDuplicate returns true…" |
| CF-ID-2 | Different project, same fingerprint | Returns false | completedFingerprints.test.js: "isDuplicate returns false for different project" |
| CF-ID-3 | Same project, unknown fingerprint | Returns false | completedFingerprints.test.js: "isDuplicate returns false for unknown fingerprint" |
| CF-ID-4 | Entry present but 8 days old (> 7-day TTL) | Returns false | completedFingerprints.test.js: "isDuplicate returns false for an entry older than 7 days (TTL enforced on read)" |
| CF-ID-5 | Entry exactly at TTL boundary (ts = now - TTL_MS) | Returns false (`>=` would make it false; `<` would make it true — the code uses `>=` so exact TTL is treated as expired) | GAP — exact TTL-ms boundary: off-by-one risk |
| CF-ID-6 | Entry 1 ms inside TTL (ts = now - TTL_MS + 1) | Returns true | GAP |
| CF-ID-7 | Entry 1 ms past TTL (ts = now - TTL_MS - 1) | Returns false | GAP |
| CF-ID-8 | `projectId == null` | Returns false immediately | GAP |
| CF-ID-9 | `fingerprint` falsy | Returns false immediately | GAP |
| CF-ID-10 | localStorage has entry but ts is not a number (corrupt value) | Returns false (typeof guard) | GAP |
| CF-ID-11 | memIndex already hydrated for project (subsequent call) | Returns from Map without re-reading localStorage | GAP — memoization correctness |

---

## 4. `completedFingerprints.js` — `pruneExpired`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-PE-1 | Single project, mix of fresh + stale entries | Stale evicted, fresh retained; key updated | completedFingerprints.test.js: "pruneExpired removes entries older than 7 days across all ls-tus-completed-* keys" |
| CF-PE-2 | Project whose all entries are stale | Key removed from localStorage entirely; memIndex entry deleted | completedFingerprints.test.js: same test (project 2) |
| CF-PE-3 | Unrelated key in localStorage | Not touched | completedFingerprints.test.js: same test ("unrelated" key) |
| CF-PE-4 | No `ls-tus-completed-*` keys exist | No-op; no exception | GAP — empty localStorage case |
| CF-PE-5 | `hasStorage()` returns false | Returns immediately | GAP |
| CF-PE-6 | Key with corrupt JSON (not parseable) | `safeParse` returns []; all "entries" filtered; key removed | GAP |
| CF-PE-7 | Key with valid JSON but not an array (e.g. `{}`) | `safeParse` returns []; key removed | GAP |
| CF-PE-8 | Entry with `ts` that is not a number | Filtered out as if expired | GAP |
| CF-PE-9 | Entry at exactly TTL boundary | Filtered out (same `< TTL_MS` check) | GAP — boundary |
| CF-PE-10 | `pidStr` is a numeric string (e.g. `"7"`) | Converted to Number(7) for memIndex.delete | GAP — memIndex invalidation with numeric vs string key |
| CF-PE-11 | `pidStr` is non-numeric (e.g. project slug) | Left as string for memIndex.delete | GAP |
| CF-PE-12 | memIndex holds a dirty entry for a project being pruned; all entries stale | memIndex.delete + dirtyProjects.delete prevent phantom write-back | GAP — dirtyProjects cleared on full prune |
| CF-PE-13 | Mix of all-stale and partial-stale projects in one localStorage | Partial: key updated + memIndex invalidated; all-stale: key removed | Partially covered by CF-PE-1/CF-PE-2 but no test covers both types in a single call |

---

## 5. `completedFingerprints.js` — `flushNow` / debounce / `scheduleFlush`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-FL-1 | dirtyProjects empty, no timer | Returns immediately; no localStorage write | completedFingerprints.test.js: "pagehide event synchronously flushes…" (calls flushNow with nothing dirty, asserts no throw) |
| CF-FL-2 | dirtyProjects has entries, timer pending | Cancels timer, writes all dirty projects to localStorage, clears dirty set | completedFingerprints.test.js: "pagehide event synchronously flushes…" (via pagehide listener) |
| CF-FL-3 | dirtyProjects has entry but memIndex has no Map for that pid | `if (!m) continue;` — skip without crash | GAP |
| CF-FL-4 | dirtyProject's Map is empty (all evicted) | localStorage.removeItem called, not setItem | GAP |
| CF-FL-5 | `hasStorage()` false on flushNow call | dirtyProjects.clear(); no localStorage write | GAP |
| CF-FL-6 | flushNow called twice with no intervening marks | Idempotent: second call is no-op | completedFingerprints.test.js: "pagehide event synchronously flushes…" (dispatches pagehide twice) |
| CF-FL-7 | markComplete called; timer fires naturally after FLUSH_DEBOUNCE_MS (1 s) | Timer fires, calls flushNow, writes to localStorage | GAP — flush-at-timer natural expiry; tests always call _flushForTests() manually |
| CF-FL-8 | markComplete called; _flushForTests called before timer fires | Timer cancelled; data written synchronously | completedFingerprints.test.js: (implicit in all tests that call flush()) |
| CF-FL-9 | Multiple markComplete calls within one 1 s window | Single timer; single flush at expiry | GAP — coalescing behavior; only one markComplete per test |
| CF-FL-10 | markComplete called; pagehide fires before FLUSH_DEBOUNCE_MS | pagehide triggers flushNow; timer cancelled; data written | completedFingerprints.test.js: "pagehide event synchronously flushes…" |
| CF-FL-11 | markComplete called; pagehide fires after FLUSH_DEBOUNCE_MS (timer already flushed) | pagehide flushNow: dirty set empty, no-op | GAP — pagehide-after-timer ordering |
| CF-FL-12 | scheduleFlush called when timer already set | Returns without creating a second timer | GAP — idempotent scheduling; tested indirectly by re-mark tests but no direct timer-count assertion |

---

## 6. `completedFingerprints.js` — `ensurePagehideListener` / `_listenerRegistered`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-PH-1 | Module first evaluated in a browser environment | Listener registered once; `_listenerRegistered` = true | completedFingerprints.test.js: "pagehide listener is registered exactly once per tab…" |
| CF-PH-2 | `_resetForTests` called then markComplete called again | Flag remains true; no second listener | completedFingerprints.test.js: same test |
| CF-PH-3 | Module evaluated in SSR/Node (no `window`) | `ensurePagehideListener` returns without registering; no error | GAP — server-side rendering guard |
| CF-PH-4 | `scheduleFlush` calls `ensurePagehideListener` after module init | Still only one listener (idempotency guard fires) | GAP — scheduleFlush-time re-check |

---

## 7. `completedFingerprints.js` — `hydrate`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CF-HY-1 | memIndex already has entry for projectId | Returns existing Map without touching localStorage | GAP — memoization: no test asserts localStorage is NOT re-read |
| CF-HY-2 | memIndex miss; localStorage has valid entries | Populates Map; entries with fp+ts added | Indirect via isDuplicate/markComplete tests |
| CF-HY-3 | memIndex miss; localStorage entry malformed (e.g. entry with no fp) | Entry skipped; Map populated with valid entries only | GAP |
| CF-HY-4 | memIndex miss; `hasStorage()` false | Returns empty Map; no localStorage read | GAP |
| CF-HY-5 | memIndex miss; localStorage key absent | Returns empty Map | GAP (isolated) |

---

## 8. `tusUpload.js` — `fingerprintForFile` usage (TUS-005 metadata field)

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| TU-FP-1 | Normal File; `lsFingerprint` injected into tus metadata | tus Upload-Metadata includes `lsFingerprint` field equal to `fingerprintForFile(file)` | GAP — no unit test for tusUpload.js at all |
| TU-FP-2 | File with no `lastModified` | `lsFingerprint` computed with `0` for lastModified | GAP |

---

## 9. `Import.jsx` — `processFiles` reducer — `uploaded` branch (TUS-002 Set dedup)

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-UP-1 | `action.uploaded` adds new items to empty `state.uploaded` | All items merged; no duplicates | GAP — no reducer unit tests |
| IR-UP-2 | `action.uploaded` contains item whose `id` already exists in `state.uploaded` | Duplicate skipped; count does not grow | GAP |
| IR-UP-3 | `action.uploaded` item with `id == null` | Item skipped | GAP |
| IR-UP-4 | Both `state.uploaded` and `action.uploaded` have items with same `id` | Only one copy in result | GAP |
| IR-UP-5 | `state.uploaded` empty, `action.uploaded` empty | `merged` stays empty | GAP |

---

## 10. `Import.jsx` — `processFiles` reducer — `ids` branch (TUS-002 Set dedup)

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-IDS-1 | New ids added to empty `state.ids` | All ids in result; `onFileListUpdate` called | GAP |
| IR-IDS-2 | Duplicate id in `action.ids` already in `state.ids` | Duplicate skipped | GAP |
| IR-IDS-3 | `id == null` in either list | Null skipped | GAP |
| IR-IDS-4 | `onFileListUpdate` callback is undefined | No throw; ids updated silently | GAP |

---

## 11. `Import.jsx` — `processFiles` reducer — `sent` branch

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-SE-1 | `action.sent` contains files present in `uploading` | Files removed from `uploading`; `progress` keys deleted; bytes folded into `completedBytes` | GAP |
| IR-SE-2 | `action.sent` file also in `failed` | Removed from `failed` (successful retry) | GAP |
| IR-SE-3 | `action.sent` file not in `uploading` (already removed) | No crash; state unchanged for that key | GAP |
| IR-SE-4 | `progress[k]` missing for a sent key | `sentBytes += 0`; no crash | GAP |

---

## 12. `Import.jsx` — `processFiles` reducer — `progress` branch

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-PR-1 | First progress tick for a file | progress key created; doneBytes updates | GAP |
| IR-PR-2 | Subsequent progress tick same file | progress key overwritten; doneBytes recalculated | GAP |
| IR-PR-3 | Concurrent progress for multiple files | inflight sums all `loaded` values | GAP |
| IR-PR-4 | `p.loaded` missing (undefined) | `|| 0` guard; no NaN propagation | GAP |

---

## 13. `Import.jsx` — `processFiles` reducer — `bumpTotals` / `bumpDone` / `resetStats`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-BT-1 | `bumpTotals` on fresh stats | `totalFiles` and `totalBytes` incremented; `startedAt` set if null | GAP |
| IR-BT-2 | `bumpTotals` when `startedAt` already set | `startedAt` preserved (not overwritten) | GAP |
| IR-BD-1 | `bumpDone` increments `doneFiles` | `doneFiles` += action.bumpDone | GAP |
| IR-RS-1 | `resetStats` | stats reset to initial; progress cleared | GAP |

---

## 14. `Import.jsx` — `enqueueOne` — `isDuplicate` filter (TUS-001)

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IE-DUP-1 | File fingerprint not in completed index | File enqueued normally | GAP |
| IE-DUP-2 | File fingerprint in completed index, within TTL | `setLastDropSkipped(n+1)` called; Promise.resolve(null) returned | GAP |
| IE-DUP-3 | File fingerprint in completed index but expired | Not a duplicate; file enqueued | GAP |
| IE-DUP-4 | `project?.id` is null/undefined | `isDuplicate` called with null projectId → returns false; file enqueued | GAP |
| IE-DUP-5 | Multiple duplicate files in one drop | `lastDropSkipped` incremented once per duplicate | GAP |
| IE-DUP-6 | All files in a drop are duplicates | No files enqueued; `lastDropSkipped == files.length`; showList still shows (skippedCount > 0) | GAP |
| IE-DUP-7 | Mix of duplicates and new files in same drop | Duplicates skipped; new files enqueued; counter reflects only skipped count | GAP |

---

## 15. `Import.jsx` — `lastDropSkipped` / `UploadProgressHeader` skip count render

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IR-SK-1 | `lastDropSkipped == 0`, no other content | Skip message not shown | GAP |
| IR-SK-2 | `lastDropSkipped == 1` | Singular "1 skipped as already uploaded" | GAP |
| IR-SK-3 | `lastDropSkipped > 1` | Plural skipped message | GAP |
| IR-SK-4 | `lastDropSkipped > 0` with active uploads (`hasTotals`) | Both totals and skip message rendered | GAP |
| IR-SK-5 | `lastDropSkipped > 0` with no other uploads (skip-only drop) | `hasTotals` false; only skip message rendered; `showList` becomes true | GAP |
| IR-SK-6 | `setLastDropSkipped(0)` reset at start of `consumeItems` | Previous drop's skip count does not carry forward | GAP |

---

## 16. `Import.jsx` — `pruneExpired` on mount (TUS-001)

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| IE-PR-1 | Import page mounts normally | `pruneExpired()` called once | GAP |
| IE-PR-2 | `pruneExpired()` throws | Swallowed by try/catch; page still mounts | GAP |
| IE-PR-3 | Import page remounts (route round-trip) | `pruneExpired()` called again; idempotent | GAP |

---

## 17. `janitor.py` — `cleanup_orphaned_tus_files`

### 17a. File-system state machine: `.meta` × `.data` × `.done` × age

Impossible states pruned:
- `.data` alone without `.meta`: not enumerated — janitor only scans `.meta`; an orphaned `.data` without `.meta` is invisible and harmless.
- `.done` alone: tested (test_mixed_directory "lonely" done) — janitor ignores it.

| State | .meta age | .data present | .done present | .done age | Expected behavior | Existing test |
|---|---|---|---|---|---|---|
| JN-1 | > TTL | yes | no | — | Pair deleted | test_deletes_stale_pair |
| JN-2 | < TTL | yes | no | — | Pair retained | test_retains_fresh_pair |
| JN-3 | = TTL exactly | yes | no | — | `.meta mtime >= cutoff` is false when equal (strict `>=`); retained | GAP — exact TTL-second boundary |
| JN-4 | = TTL + 1s | yes | no | — | Candidate; pair deleted | GAP — 1 s past TTL |
| JN-5 | > TTL | no | no | — | `_safe_unlink(data_path)` returns 0 but `deleted` still incremented | GAP — .data missing at deletion time |
| JN-6 | > TTL | yes | yes | < TTL (fresh) | Pair skipped; .done kept | test_retains_pair_with_fresh_done_peer |
| JN-7 | > TTL | yes | yes | > TTL (stale) | Pair deleted; .done kept | test_deletes_pair_with_stale_done_peer |
| JN-8 | > TTL | yes | yes | = TTL exactly | .done mtime >= cutoff → skip (same boundary as JN-3) | GAP |
| JN-9 | > TTL | yes | yes | .done mtime OSError | `done_mtime = 0.0`; 0 < cutoff → not fresh → pair deleted | GAP |
| JN-10 | > TTL | yes | no | — | `.meta` stat fails (OSError) | `continue` — pair not counted | GAP |
| JN-11 | mixed | mixed | mixed | mixed | Multiple pairs: stale deleted, fresh retained, recent-done skipped | test_mixed_directory |
| JN-12 | > TTL | yes | no | — | upload_dir does not exist | Returns all-zero result | test_missing_upload_dir_is_noop |
| JN-13 | > TTL | yes | no | — | upload_dir is a file not a dir | `os.scandir` raises `NotADirectoryError` (subclass of OSError) caught by `FileNotFoundError` handler? | GAP — not a directory path |

### 17b. `_safe_unlink` states

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| JN-SU-1 | File exists, remove succeeds | Returns file size in bytes | Implicit in JN-1 / JN-7 |
| JN-SU-2 | File does not exist | `os.path.getsize` raises OSError; returns 0 | JN-5 partial (no test isolates _safe_unlink) |
| JN-SU-3 | File exists but `os.remove` raises (permission error) | Logs warning; returns 0; `deleted` not incremented for that file | GAP |
| JN-SU-4 | File size is 0 | Returns 0; `deleted` still incremented (meta present, data 0-byte) | GAP |

### 17c. Settings / default resolution

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| JN-CFG-1 | All three args omitted | Reads `settings.TUS_UPLOAD_DIR`, `TUS_ORPHAN_TTL_DAYS`, `time.time()` | test_reads_settings_when_args_omitted |
| JN-CFG-2 | `TUS_ORPHAN_TTL_DAYS` not set in settings | `getattr(settings, …, 7)` returns 7 | GAP — missing-setting fallback |
| JN-CFG-3 | `TUS_ORPHAN_TTL_DAYS` set to 0 | cutoff = now; every .meta file is a candidate | GAP |
| JN-CFG-4 | `TUS_ORPHAN_TTL_DAYS` set to negative | cutoff > now; all files retained | GAP |

---

## 18. `cleanup_tus_orphans.py` management command

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CMD-1 | `--sync` flag passed | Runs `cleanup_orphaned_tus_files()` inline; prints SUCCESS | GAP |
| CMD-2 | No `--sync` flag | Dispatches to rq `low` queue (or inline if no Redis); prints dispatched | GAP |
| CMD-3 | Redis unavailable (OSS default) | `start_job_async_or_sync` runs inline; still succeeds | GAP |
| CMD-4 | Django `call_command` invoked in test environment | No crash; result written to stdout | GAP |

---

## 19. `receivers.py` — `on_tus_upload_finished`

### 19a. Core dispatch path

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| RX-1 | New file, unique fingerprint, project exists | FileUpload row created; fingerprint stamped; temp file removed; .done written | test_tus_dedup.py: test_same_fingerprint_reuses_row (first finalize leg) |
| RX-2 | Same fingerprint, same project, within dedup window | No new row; temp file removed; .done for duplicate resource_id written with original id | test_tus_dedup.py: test_done_marker_written_on_dedup_hit |
| RX-3 | Same fingerprint, same project, outside dedup window | New row created (no dedup); temp file removed | test_tus_dedup.py: test_outside_ttl_window_does_not_dedup |
| RX-4 | Same fingerprint, different project | New row created; no cross-project dedup | test_tus_dedup.py: test_different_projects_do_not_dedup |
| RX-5 | Different fingerprints, same project | Two rows created | test_tus_dedup.py: test_different_fingerprints_create_separate_rows |
| RX-6 | No `lsFingerprint` in metadata (legacy client) | `fingerprint = None`; dedup skipped; row created without fingerprint | test_tus_dedup.py: test_missing_fingerprint_skips_dedup |
| RX-7 | `lsFingerprint` is empty string | `or None` converts to None; same as RX-6 | test_tus_dedup.py: TestFindExistingHelper.test_returns_none_for_missing_fingerprint (helper-level) |

### 19b. Error paths

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| RX-ERR-1 | `projectId` missing from metadata | Logs error; `_safe_remove` temp file; returns | GAP |
| RX-ERR-2 | `projectId` present but project does not exist | `Project.DoesNotExist` caught; logs error; removes temp file; returns | GAP |
| RX-ERR-3 | `projectId` is non-integer string (e.g. `"abc"`) | `int(project_id)` raises ValueError; uncaught → signal framework logs exception | GAP |
| RX-ERR-4 | `create_file_upload` raises exception | Logged; temp file removed; exception re-raised (propagates to signal sender) | GAP |
| RX-ERR-5 | `_write_done_marker` fails (OSError on write) | Logs warning; receiver returns normally; client stalls waiting for .done | GAP |
| RX-ERR-6 | `upload_file_path` is None or missing | `_safe_remove` no-ops; `open(None, 'rb')` raises TypeError inside try/except | GAP |
| RX-ERR-7 | Temp file removed between finalize and `open()` call | `FileNotFoundError` inside try/except; logged; re-raised | GAP |

### 19c. Fingerprint stamping post-save

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| RX-ST-1 | `fingerprint` truthy and `file_upload.fingerprint != fingerprint` | Second `save(update_fields=['fingerprint'])` called | test_tus_dedup.py: test_same_fingerprint_reuses_row (asserts `rows.first().fingerprint == fp`) |
| RX-ST-2 | `fingerprint` truthy but `create_file_upload` already set it (unlikely) | `file_upload.fingerprint == fingerprint` → second save skipped | GAP |
| RX-ST-3 | `fingerprint` is None | Stamp skipped; `file_upload.fingerprint` remains None | Implicit in test_missing_fingerprint_skips_dedup |

---

## 20. `receivers.py` — `_find_existing_fileupload`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| RX-FE-1 | Empty or None fingerprint | Returns None immediately | test_tus_dedup.py: TestFindExistingHelper.test_returns_none_for_missing_fingerprint |
| RX-FE-2 | Match exists, within window | Returns most-recent FileUpload | test_tus_dedup.py: TestFindExistingHelper.test_returns_most_recent_match |
| RX-FE-3 | Match exists, outside window | Returns None | test_tus_dedup.py: test_outside_ttl_window_does_not_dedup (signal-level); no isolated helper-level test |
| RX-FE-4 | No match in DB | Returns None | GAP — no test for "no rows at all" at helper level (only tested transitively) |
| RX-FE-5 | `TUS_SERVER_DEDUP_WINDOW_HOURS` not set in settings | `getattr` defaults to 24 | GAP |
| RX-FE-6 | `TUS_SERVER_DEDUP_WINDOW_HOURS` set to 0 | Window = 0 h; `cutoff = now`; `created_at__gte=now` matches nothing; returns None (no dedup) | GAP |
| RX-FE-7 | `TUS_SERVER_DEDUP_WINDOW_HOURS` set to non-integer string | `int(getattr(...))` raises ValueError; propagates to signal handler | GAP |
| RX-FE-8 | Multiple matches within window | Returns the one with highest `created_at` | test_tus_dedup.py: TestFindExistingHelper.test_returns_most_recent_match |
| RX-FE-9 | Exact dedup window boundary (created_at = cutoff to the second) | `created_at__gte=cutoff`: row at exactly cutoff is included | GAP — off-by-one on boundary |

---

## 21. `models.py` — `FileUpload` new fields

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| MDL-1 | Row created via tus receiver with fingerprint | `fingerprint` and `created_at` populated | test_tus_dedup.py (indirect) |
| MDL-2 | Row created via legacy import (no fingerprint) | `fingerprint` is None; `created_at` set by auto_now_add | GAP — legacy path does not set fingerprint; nullable test |
| MDL-3 | `created_at` on legacy rows (pre-migration) | NULL in DB; code must handle None in `_find_existing_fileupload` | GAP — `created_at__gte=cutoff` with null rows: Django ORM excludes NULL by default (correct); no test asserts this |
| MDL-4 | `fingerprint` at max length (512 chars) | Stored correctly | GAP |
| MDL-5 | `fingerprint` over max length (513+ chars) | DB raises DataError or Django truncates depending on backend | GAP |
| MDL-6 | Index `data_import_fu_proj_fp_idx` present post-migration | Composite `(project, fingerprint)` index exists in schema | GAP — no introspection test |

---

## 22. Migration `0003_fileupload_created_at_fileupload_fingerprint_and_more`

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| MIG-1 | Forward migration on empty DB | Columns `fingerprint`, `created_at` added; composite index created | GAP |
| MIG-2 | Forward migration with existing rows | Existing rows get `fingerprint=NULL`, `created_at=NULL` | GAP |
| MIG-3 | Reverse migration | Columns and index removed | GAP — `migrations.AddIndex` has no reverse op defined; default reverse deletes index |
| MIG-4 | Idempotency: forward migration applied twice (e.g. fake applied state) | Django squash / `--fake` path; no crash | GAP |
| MIG-5 | `created_at` auto_now_add on new rows post-migration | Timestamp set automatically | Implicit in test_tus_dedup.py but not an explicit migration test |

---

## 23. `base.py` — `TUS_ORPHAN_TTL_DAYS` and `TUS_SERVER_DEDUP_WINDOW_HOURS` settings

| State | Inputs / preconditions | Expected behavior | Existing test |
|---|---|---|---|
| CFG-1 | Neither env var set | Defaults: TTL_DAYS=7, DEDUP_HOURS=24 | GAP — no settings-level test |
| CFG-2 | `TUS_ORPHAN_TTL_DAYS=14` set in env | Parsed as int(14) | GAP |
| CFG-3 | `TUS_ORPHAN_TTL_DAYS=abc` (non-int) | `int()` raises ValueError at startup | GAP |
| CFG-4 | `TUS_ORPHAN_TTL_DAYS=0` | Zero accepted; janitor deletes everything immediately | GAP |
| CFG-5 | `TUS_ORPHAN_TTL_DAYS=-1` | Negative int accepted; cutoff > now; janitor deletes nothing | GAP |
| CFG-6 | `TUS_SERVER_DEDUP_WINDOW_HOURS=0` | Zero accepted; no dedup ever fires | GAP |
| CFG-7 | `TUS_SERVER_DEDUP_WINDOW_HOURS=-1` | Negative int accepted; cutoff > now; `created_at__gte=future` matches nothing | GAP |
| CFG-8 | `TUS_SERVER_DEDUP_WINDOW_HOURS=xyz` (non-int) | `int()` raises ValueError at startup | GAP |

---

## Gap summary

### Frontend (`completedFingerprints.js`)

- **CF-FP-3** (P2): `lastModified` non-number type — typeof guard branch untested
- **CF-FP-4** (P2): null/undefined File argument to `fingerprintForFile`
- **CF-FP-5** (P3): empty string `file.name`
- **CF-FP-6** (P1): colon in filename — delimiter ambiguity; server and client must agree on parse; never tested
- **CF-MC-4** (P2): exactly MAX_ENTRIES boundary — no eviction; only over-cap is tested
- **CF-MC-7** (P2): `markComplete` with `projectId == null` — early-return branch
- **CF-MC-8** (P2): `markComplete` with falsy fingerprint — early-return branch
- **CF-MC-9** (P2): `markComplete` with no `window` (SSR/Node) — scheduleFlush short-circuit
- **CF-ID-5** (P1): `isDuplicate` at exact TTL boundary — off-by-one
- **CF-ID-6** (P2): 1 ms inside TTL — should be true
- **CF-ID-7** (P2): 1 ms past TTL — should be false
- **CF-ID-8** (P2): null projectId → should return false immediately
- **CF-ID-9** (P2): falsy fingerprint → should return false immediately
- **CF-ID-10** (P2): corrupt `ts` in localStorage entry
- **CF-PE-4** (P2): `pruneExpired` with no matching keys
- **CF-PE-5** (P2): `pruneExpired` with no storage
- **CF-PE-6** (P2): `pruneExpired` with corrupt JSON key
- **CF-PE-8** (P2): entry with non-number `ts` in pruneExpired
- **CF-PE-9** (P1): `pruneExpired` exact TTL boundary — same risk as CF-ID-5
- **CF-PE-12** (P1): pruning all-stale project must clear `dirtyProjects` to prevent phantom write-back
- **CF-FL-3** (P2): `flushNow` with dirty pid but no Map in memIndex
- **CF-FL-4** (P2): `flushNow` when Map is empty — should removeItem not setItem
- **CF-FL-7** (P2): debounce fires naturally (no manual flush helper)
- **CF-FL-9** (P2): multiple `markComplete` calls coalesced into one flush
- **CF-FL-11** (P2): pagehide after timer already fired — should be no-op
- **CF-PH-3** (P2): SSR/Node — `ensurePagehideListener` with no `window`

### Frontend (`tusUpload.js`)

- **TU-FP-1** (P1): no unit tests at all for `tusUpload.js` — fingerprint metadata injection, `fetchFileUploadId`, abort behavior all unverified

### Frontend (`Import.jsx`)

- All `processFiles` reducer branches — **IR-UP-1..5**, **IR-IDS-1..4**, **IR-SE-1..4**, **IR-PR-1..4**, **IR-BT-1..2**, **IR-BD-1**, **IR-RS-1** (P2): zero reducer unit tests
- All `enqueueOne` isDuplicate states — **IE-DUP-1..7** (P1/P2): no tests for skip logic in `Import.jsx`
- All `lastDropSkipped` render states — **IR-SK-1..6** (P2): no render tests
- `pruneExpired` on mount — **IE-PR-1..3** (P2)

> Deferred render tests (IR-SK-1..6, IE-PR-1..3) require the full Label Studio shell
> to mount. Per `.cursor/rules/cypress_tests.mdc`, these belong in
> `web/libs/editor/tests/integration/e2e/` (NOT co-located next to the component),
> using helpers from `@humansignal/frontend-test/helpers/LSF` and data fixtures
> under `web/libs/editor/tests/integration/data/`. File as `.cy.ts`.

### Backend (`janitor.py`)

- **JN-3** (P1): exact TTL-second boundary — `>=` comparison; off-by-one
- **JN-5** (P2): `.data` file missing at deletion time — `deleted` counter still increments
- **JN-8** (P1): `.done` exact TTL boundary
- **JN-9** (P2): `.done` mtime OSError → `done_mtime = 0.0` fallback
- **JN-10** (P2): `.meta` stat OSError
- **JN-13** (P2): `upload_dir` is a path to a file not a directory
- **JN-SU-3** (P1): `os.remove` permission error — `_safe_unlink` returns 0; `deleted` not incremented
- **JN-SU-4** (P2): 0-byte `.data` file
- **JN-CFG-2** (P2): `TUS_ORPHAN_TTL_DAYS` not in settings — fallback to 7
- **JN-CFG-3** (P1): `TUS_ORPHAN_TTL_DAYS=0`
- **JN-CFG-4** (P2): `TUS_ORPHAN_TTL_DAYS` negative

### Backend (`cleanup_tus_orphans.py`)

- **CMD-1..4** (P2): management command entirely untested

### Backend (`receivers.py`)

- **RX-ERR-1** (P1): missing `projectId` in metadata
- **RX-ERR-2** (P2): project not found
- **RX-ERR-3** (P1): non-integer `projectId` — unhandled ValueError
- **RX-ERR-4** (P1): `create_file_upload` raises — exception re-raised; side-effects (temp file removal) verified?
- **RX-ERR-5** (P1): `.done` write failure — client stalls permanently
- **RX-ERR-6** (P2): `upload_file_path` is None
- **RX-FE-5** (P2): `TUS_SERVER_DEDUP_WINDOW_HOURS` not in settings
- **RX-FE-6** (P1): `TUS_SERVER_DEDUP_WINDOW_HOURS=0` — dedup silently disabled
- **RX-FE-7** (P1): `TUS_SERVER_DEDUP_WINDOW_HOURS` non-integer — ValueError at finalize time
- **RX-FE-9** (P1): dedup window exact boundary

### Backend (`models.py` + migration)

- **MDL-2** (P2): legacy row without fingerprint
- **MDL-3** (P1): NULL `created_at` rows in dedup query — ORM excludes NULL; no test asserts this
- **MDL-4** (P2): max-length fingerprint (512 chars)
- **MDL-5** (P1): over-length fingerprint (513+ chars) — DB behavior undefined by code
- **MIG-1..4** (P2): migration not tested at all

### Settings (`base.py`)

- **CFG-3** (P1): `TUS_ORPHAN_TTL_DAYS` non-integer crashes startup
- **CFG-8** (P1): `TUS_SERVER_DEDUP_WINDOW_HOURS` non-integer crashes startup
- **CFG-4..7** (P2): zero/negative values for both settings

---

### Gap counts

| Priority | Count |
|---|---|
| P1 (correctness) | 21 |
| P2 (edge case) | 47 |
| P3 (theoretical) | 3 |
| **Total** | **71** |

### Top 10 most important gaps

1. **CF-FP-6 / RX-ST** (P1): colon in `file.name` — the dedup key formula `<name>:<size>:<lm>` uses `:` as delimiter; a filename containing `:` makes the key ambiguous. No test validates that client-side `fingerprintForFile` and server-side usage agree when the name contains colons.
2. **TU-FP-1** (P1): `tusUpload.js` has zero unit tests — the `lsFingerprint` metadata injection (TUS-005 client side), `fetchFileUploadId`, retry behavior on `onError`, and abort path are entirely untested at unit level.
3. **RX-ERR-3** (P1): non-integer `projectId` in metadata causes an unhandled `ValueError` inside the signal receiver at `int(project_id)`; server returns 500 and temp file may not be cleaned.
4. **RX-ERR-5** (P1): `.done` marker write failure — if `_write_done_marker` raises `OSError`, the receiver returns normally but the client's `fetchFileUploadId` GET will never find the marker and will loop/stall indefinitely. No test verifies the failure mode.
5. **MDL-3 / RX-FE-4** (P1): pre-migration `FileUpload` rows have `created_at=NULL`. `_find_existing_fileupload` issues `created_at__gte=cutoff`; Django ORM correctly excludes NULLs, so legacy rows are never matched — this is the correct behavior but it is not asserted anywhere. A future ORM version or annotation could change the exclusion silently.
6. **MDL-5** (P1): fingerprint field is `max_length=512`; no truncation is performed before `save()`. A filename of 510 chars + size + lastModified suffix easily exceeds 512. The DB will raise `DataError` (Postgres) or silently truncate (MySQL with strict mode off); the receiver's exception handler re-raises, leaving a temp file on disk.
7. **IE-DUP-1..7** (P1/P2): the `isDuplicate` skip logic in `enqueueOne` — the path that increments `lastDropSkipped` and returns `Promise.resolve(null)` — is exercised only by the integration tier-resume tests, not by any unit test. The "all-duplicate-drop" case (IE-DUP-6) where `showList` must still become true is completely untested.
8. **JN-3 / JN-8** (P1): exact TTL boundary handling in janitor. The condition is `meta_mtime >= cutoff` (retain if equal or newer). An upload whose `.meta` mtime is _exactly_ `now - ttl_days * 86400` is retained, not deleted. The off-by-one is benign in practice but the behavior is unspecified by any test.
9. **CF-ID-5 / CF-PE-9** (P1): `isDuplicate` and `pruneExpired` both use `Date.now() - ts >= TTL_MS` to detect expiry. An entry at exactly the TTL moment is treated as expired. No test pins this boundary, so a future `>` vs `>=` change would be invisible.
10. **CMD-1..4** (P2): the management command `cleanup_tus_orphans` is completely untested — neither `--sync` execution, nor rq dispatch, nor the `start_job_async_or_sync` fallback path is covered. The command is the primary operational trigger for TUS-003 in production.

---

## Final coverage (2026-04-19)

All 71 originally-identified gaps closed across 10 commits. Every state enumerated in sections 1-23 now has a direct or explicitly-indirect test.

| Phase | Tests added | Suites | Bug fixes |
|---|---|---|---|
| Initial coverage pass (4 parallel engineers) | 105 | + | 5 (colon ambiguity, non-int projectId, .done write failure, non-int env var, over-length fingerprint) |
| Residual unit-testable gaps (CF-MC-10, CF-PH-4, CF-PE-10..11, CF-HY-3..5) | 7 | existing | 0 |
| Render + mount gaps (IR-SK-1..6, IE-PR-1..3) | 9 | +2 new | 0 |
| **Total** | **121** | | **5** |

**Final test counts:**
- Frontend (Jest, `npx nx run labelstudio:unit`): **108 passed**, 8 suites
- Backend (pytest, `pytest label_studio/tests/data_import/`): **103 passed**
- Smoke (Playwright `tier_resume` + `tier3`): PASS

**State IDs explicitly covered by unit tests:**
- completedFingerprints.js: CF-FP-1..6, CF-MC-1..10, CF-ID-1..11, CF-PE-1..13, CF-FL-1..12, CF-PH-1..4, CF-HY-1..5
- tusUpload.js: TU-FP-1..2
- Import reducer + enqueue: IR-UP-1..5, IR-IDS-1..4, IR-SE-1..4, IR-PR-1..4, IR-BT-1..2, IR-BD-1, IR-RS-1, IE-DUP-1..7
- UploadProgressHeader + pruneExpired hook: IR-SK-1..6, IE-PR-1..3
- janitor: JN-1..13, JN-SU-1..4, JN-CFG-1..4
- cleanup_tus_orphans command: CMD-1..4
- receivers: RX-1..7, RX-ERR-1..7, RX-ST-1..3, RX-FE-1..9
- FileUpload model: MDL-1..6
- migration 0003: MIG-1..5
- TUS settings: CFG-1..8

**Two residual states marked "indirect" in the matrix** (MDL-1 and MIG-5) are transitively exercised by every `test_tus_dedup.py` test (auto_now_add fires, fingerprint column is populated). No standalone test added since the behavior cannot regress without breaking the full dedup path.
