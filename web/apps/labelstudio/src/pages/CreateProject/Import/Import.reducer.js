/**
 * Reducer + pure helpers extracted from Import.jsx so they can be unit-tested
 * in isolation. Exporting both the pure reducer factory (which takes an
 * `onFileListUpdate` side-effect callback) and the base initial state keeps
 * Import.jsx's behavior identical while letting the test suite exercise every
 * branch without mounting the full React component (TESTING-STATE-MATRIX
 * sections 9-13).
 */

import { fingerprintForFile, isDuplicate } from "./completedFingerprints";

export function initialStats() {
  return {
    totalFiles: 0,
    doneFiles: 0,
    totalBytes: 0,
    doneBytes: 0,
    // cumulative bytes for already-finished files, folded in by `sent`
    completedBytes: 0,
    startedAt: null,
  };
}

export function initialReducerState() {
  return {
    uploaded: [],
    uploading: [],
    ids: [],
    progress: {},
    failed: [],
    stats: initialStats(),
  };
}

/**
 * Build the processFiles reducer. `onFileListUpdate` is the sole non-pure
 * dependency — it's invoked inside the `ids` branch. Factoring it out as a
 * factory arg lets tests pass a spy without mocking module imports.
 */
export function createProcessFiles(onFileListUpdate) {
  return function processFiles(state, action) {
    if (action.sending) {
      return { ...state, uploading: [...action.sending, ...state.uploading] };
    }
    if (action.sent) {
      // `action.sent` is an array of File objects that just finished. Remove
      // them from `uploading` AND clear any stale progress/failed entries so
      // successful rows don't linger as failures. Fold their final `loaded`
      // byte count into `stats.completedBytes` so the aggregate doneBytes
      // stays cumulative even after we drop the entries (otherwise the
      // "X / Y" byte readout jumps back to ~zero each time a batch finishes
      // and the ETA becomes nonsense).
      //
      // Indexing by `_tusKey` (a monotonic counter attached at enqueue time),
      // NOT by `file.name` — 8000-image stress datasets routinely have
      // duplicate basenames across subdirectories (w0/img_001.png,
      // w1/img_001.png, ...). Indexing by name conflates them: finishing one
      // would remove all of them from `uploading` and double-count their
      // bytes in completedBytes.
      const sentKeys = new Set(action.sent.map((f) => f._tusKey));
      const progress = { ...state.progress };
      let sentBytes = 0;
      for (const k of sentKeys) {
        const p = progress[k];
        if (p) sentBytes += p.loaded || 0;
        delete progress[k];
      }
      return {
        ...state,
        uploading: state.uploading.filter((f) => !sentKeys.has(f._tusKey)),
        failed: state.failed.filter((e) => !sentKeys.has(e.file._tusKey)),
        progress,
        stats: {
          ...state.stats,
          completedBytes: (state.stats.completedBytes || 0) + sentBytes,
        },
      };
    }
    if (action.uploaded) {
      // TUS-002: use a Set for O(1) id-dedup. The legacy
      // `unique(list, eq)` helper does a reduce+findIndex pass, which is
      // O(N^2) in the size of the resulting list. For a 7980-file Tier-4
      // upload this reducer runs once per tus success, so the total
      // dedup work grows as O(N^3) and dominates the second-half
      // throughput floor (measured: rate30 falls from ~8 f/s at
      // N=200 to ~2 f/s at N=5000 with nothing else changing).
      const seen = new Set();
      const merged = [];
      for (const arr of [state.uploaded, action.uploaded]) {
        for (const item of arr) {
          const id = item?.id;
          if (id == null || seen.has(id)) continue;
          seen.add(id);
          merged.push(item);
        }
      }
      return { ...state, uploaded: merged };
    }
    if (action.ids) {
      // TUS-002: same O(N^2) -> O(N) change as the `uploaded` branch. The
      // `ids` list is used by onFileListUpdate and, via dispatchers for
      // every completed upload, grows to N entries across a run.
      const seen = new Set();
      const ids = [];
      for (const arr of [state.ids, action.ids]) {
        for (const id of arr) {
          if (id == null || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
        }
      }
      onFileListUpdate?.(ids);
      return { ...state, ids };
    }
    if (action.progress) {
      const { key, loaded, total } = action.progress;
      const nextProgress = { ...state.progress, [key]: { loaded, total } };
      // doneBytes = bytes already committed (completedBytes) + bytes in-flight
      // right now. This stays monotonically non-decreasing across the lifetime
      // of a batch because completed files no longer appear in `progress`
      // after the `sent` action folds their size into completedBytes.
      let inflight = 0;
      for (const p of Object.values(nextProgress)) {
        inflight += p.loaded || 0;
      }
      const doneBytes = (state.stats.completedBytes || 0) + inflight;
      return {
        ...state,
        progress: nextProgress,
        stats: {
          ...state.stats,
          doneBytes,
          // totalBytes is owned by bumpTotals, do not overwrite here.
          startedAt: state.stats.startedAt || Date.now(),
        },
      };
    }
    if (action.failed) {
      const { file, error } = action.failed;
      return {
        ...state,
        uploading: state.uploading.filter((f) => f._tusKey !== file._tusKey),
        failed: [
          ...state.failed.filter((e) => e.file._tusKey !== file._tusKey),
          { file, error: String(error?.message ?? error ?? "Upload failed"), retries: 0 },
        ],
      };
    }
    if (action.retry) {
      return {
        ...state,
        failed: state.failed.filter((e) => e.file._tusKey !== action.retry._tusKey),
      };
    }
    if (action.bumpTotals) {
      return {
        ...state,
        stats: {
          ...state.stats,
          totalFiles: (state.stats.totalFiles || 0) + action.bumpTotals.files,
          totalBytes: (state.stats.totalBytes || 0) + action.bumpTotals.bytes,
          startedAt: state.stats.startedAt || Date.now(),
        },
      };
    }
    if (action.bumpDone) {
      return {
        ...state,
        stats: {
          ...state.stats,
          doneFiles: (state.stats.doneFiles || 0) + action.bumpDone,
        },
      };
    }
    if (action.resetStats) {
      return { ...state, stats: initialStats(), progress: {} };
    }
    return state;
  };
}

/**
 * TUS-001 skip-as-duplicate decision. Wraps fingerprint computation + the
 * per-project TTL index check. `projectId` may be nullish — in which case
 * `isDuplicate` short-circuits to false and the caller enqueues the file.
 *
 * Pure (given `completedFingerprints`'s module-level state): one call, one
 * answer. Exported so Import.jsx and unit tests share the same decision.
 */
export function shouldSkipAsDuplicate(file, projectId) {
  if (projectId == null) return false;
  return isDuplicate(projectId, fingerprintForFile(file));
}
