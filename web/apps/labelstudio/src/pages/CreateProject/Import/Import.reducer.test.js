/**
 * Unit tests for the Import.jsx processFiles reducer + helpers.
 *
 * Covers TESTING-STATE-MATRIX sections:
 *   - 9 uploaded branch: IR-UP-1..5
 *   - 10 ids branch: IR-IDS-1..4
 *   - 11 sent branch: IR-SE-1..4
 *   - 12 progress branch: IR-PR-1..4
 *   - 13 bumpTotals / bumpDone / resetStats: IR-BT-1..2, IR-BD-1, IR-RS-1
 *   - 14 shouldSkipAsDuplicate helper (via Import.reducer): IE-DUP-1..7
 */

import {
  createProcessFiles,
  initialReducerState,
  initialStats,
  shouldSkipAsDuplicate,
} from "./Import.reducer";
import {
  markComplete,
  keyForProject,
  _resetForTests,
} from "./completedFingerprints";

// Small helpers --------------------------------------------------------------

const fileOf = (tusKey, extra = {}) => ({
  _tusKey: tusKey,
  name: `${tusKey}.jpg`,
  size: 100,
  ...extra,
});

const freshState = (overrides = {}) => ({ ...initialReducerState(), ...overrides });

describe("processFiles reducer — uploaded branch (IR-UP-*)", () => {
  const reducer = createProcessFiles();

  test("IR-UP-1: new items merge into empty uploaded array", () => {
    const next = reducer(freshState(), { uploaded: [{ id: 1 }, { id: 2 }] });
    expect(next.uploaded).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("IR-UP-2: duplicate id in action skipped against existing state", () => {
    const state = freshState({ uploaded: [{ id: 1, file: "a" }] });
    const next = reducer(state, { uploaded: [{ id: 1, file: "a-dup" }, { id: 2 }] });
    // First occurrence (state) wins — Set dedup iterates state then action.
    expect(next.uploaded).toEqual([{ id: 1, file: "a" }, { id: 2 }]);
  });

  test("IR-UP-3: items with null/undefined id are skipped", () => {
    const next = reducer(freshState(), {
      uploaded: [{ id: null }, { id: undefined }, { id: 1 }],
    });
    expect(next.uploaded).toEqual([{ id: 1 }]);
  });

  test("IR-UP-4: overlapping ids across both lists deduped", () => {
    const state = freshState({ uploaded: [{ id: 1 }, { id: 2 }] });
    const next = reducer(state, { uploaded: [{ id: 2 }, { id: 3 }] });
    expect(next.uploaded.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test("IR-UP-5: both lists empty yields empty merged", () => {
    const next = reducer(freshState(), { uploaded: [] });
    // Reducer short-circuits out of `action.uploaded` when truthy — [] is
    // falsy in the `if (action.uploaded)` check because [] is truthy... wait,
    // [] is truthy in JS. Verify: branch taken, result still []:
    expect(next.uploaded).toEqual([]);
  });
});

describe("processFiles reducer — ids branch (IR-IDS-*)", () => {
  test("IR-IDS-1: new ids added; onFileListUpdate fired", () => {
    const spy = jest.fn();
    const reducer = createProcessFiles(spy);
    const next = reducer(freshState(), { ids: [1, 2, 3] });
    expect(next.ids).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledWith([1, 2, 3]);
  });

  test("IR-IDS-2: duplicate id already in state skipped", () => {
    const reducer = createProcessFiles();
    const next = reducer(freshState({ ids: [1, 2] }), { ids: [2, 3] });
    expect(next.ids).toEqual([1, 2, 3]);
  });

  test("IR-IDS-3: null ids filtered out", () => {
    const reducer = createProcessFiles();
    const next = reducer(freshState({ ids: [1] }), { ids: [null, undefined, 2, null] });
    expect(next.ids).toEqual([1, 2]);
  });

  test("IR-IDS-4: undefined onFileListUpdate does not throw", () => {
    const reducer = createProcessFiles(undefined);
    expect(() => reducer(freshState(), { ids: [1] })).not.toThrow();
  });
});

describe("processFiles reducer — sent branch (IR-SE-*)", () => {
  const reducer = createProcessFiles();

  test("IR-SE-1: sent files removed from uploading; progress deleted; bytes folded", () => {
    const f1 = fileOf("k1");
    const f2 = fileOf("k2");
    const state = freshState({
      uploading: [f1, f2],
      progress: { k1: { loaded: 50, total: 100 }, k2: { loaded: 10, total: 100 } },
      stats: { ...initialStats(), completedBytes: 200 },
    });
    const next = reducer(state, { sent: [f1] });
    expect(next.uploading).toEqual([f2]);
    expect(next.progress).toEqual({ k2: { loaded: 10, total: 100 } });
    expect(next.stats.completedBytes).toBe(250);
  });

  test("IR-SE-2: sent file also present in failed is cleared from failed", () => {
    const f1 = fileOf("k1");
    const state = freshState({
      uploading: [f1],
      progress: { k1: { loaded: 100, total: 100 } },
      failed: [{ file: f1, error: "flaked", retries: 0 }],
    });
    const next = reducer(state, { sent: [f1] });
    expect(next.failed).toEqual([]);
  });

  test("IR-SE-3: sent file not in uploading — no crash; filters are no-ops", () => {
    const f_unknown = fileOf("ghost");
    const state = freshState({ uploading: [fileOf("k1")], progress: {} });
    const next = reducer(state, { sent: [f_unknown] });
    expect(next.uploading.map((f) => f._tusKey)).toEqual(["k1"]);
    expect(next.stats.completedBytes).toBe(0);
  });

  test("IR-SE-4: progress missing for sent key — sentBytes += 0", () => {
    const f1 = fileOf("k1");
    const state = freshState({ uploading: [f1], progress: {} });
    const next = reducer(state, { sent: [f1] });
    expect(next.stats.completedBytes).toBe(0);
    expect(next.uploading).toEqual([]);
  });
});

describe("processFiles reducer — progress branch (IR-PR-*)", () => {
  const reducer = createProcessFiles();

  test("IR-PR-1: first progress tick creates the key; doneBytes updates", () => {
    const next = reducer(freshState(), { progress: { key: "k1", loaded: 10, total: 100 } });
    expect(next.progress.k1).toEqual({ loaded: 10, total: 100 });
    expect(next.stats.doneBytes).toBe(10);
    expect(next.stats.startedAt).not.toBeNull();
  });

  test("IR-PR-2: subsequent tick overwrites; doneBytes recalculated", () => {
    const state = freshState({
      progress: { k1: { loaded: 10, total: 100 } },
      stats: { ...initialStats(), startedAt: 1, completedBytes: 0 },
    });
    const next = reducer(state, { progress: { key: "k1", loaded: 50, total: 100 } });
    expect(next.progress.k1.loaded).toBe(50);
    expect(next.stats.doneBytes).toBe(50);
    // startedAt preserved, not overwritten.
    expect(next.stats.startedAt).toBe(1);
  });

  test("IR-PR-3: concurrent progress for multiple files sums inflight", () => {
    const state = freshState({ progress: { k1: { loaded: 30, total: 100 } } });
    const next = reducer(state, { progress: { key: "k2", loaded: 40, total: 100 } });
    expect(next.stats.doneBytes).toBe(70);
  });

  test("IR-PR-4: undefined loaded falls back to 0 (no NaN)", () => {
    const next = reducer(freshState(), {
      progress: { key: "k1", loaded: undefined, total: 100 },
    });
    expect(Number.isNaN(next.stats.doneBytes)).toBe(false);
    expect(next.stats.doneBytes).toBe(0);
  });
});

describe("processFiles reducer — bumpTotals / bumpDone / resetStats (IR-BT/BD/RS)", () => {
  const reducer = createProcessFiles();

  test("IR-BT-1: bumpTotals on fresh stats sets totals and startedAt", () => {
    const next = reducer(freshState(), { bumpTotals: { files: 3, bytes: 9000 } });
    expect(next.stats.totalFiles).toBe(3);
    expect(next.stats.totalBytes).toBe(9000);
    expect(next.stats.startedAt).not.toBeNull();
  });

  test("IR-BT-2: bumpTotals preserves pre-existing startedAt", () => {
    const state = freshState({ stats: { ...initialStats(), startedAt: 42 } });
    const next = reducer(state, { bumpTotals: { files: 1, bytes: 10 } });
    expect(next.stats.startedAt).toBe(42);
  });

  test("IR-BD-1: bumpDone increments doneFiles", () => {
    const state = freshState({ stats: { ...initialStats(), doneFiles: 2 } });
    const next = reducer(state, { bumpDone: 3 });
    expect(next.stats.doneFiles).toBe(5);
  });

  test("IR-RS-1: resetStats clears stats + progress", () => {
    const state = freshState({
      progress: { k1: { loaded: 1, total: 2 } },
      stats: { ...initialStats(), totalFiles: 5, doneFiles: 3, startedAt: 1 },
    });
    const next = reducer(state, { resetStats: true });
    expect(next.stats).toEqual(initialStats());
    expect(next.progress).toEqual({});
  });
});

describe("shouldSkipAsDuplicate helper (IE-DUP-*)", () => {
  beforeEach(() => {
    _resetForTests();
    localStorage.clear();
  });

  test("IE-DUP-1: unknown fingerprint — returns false (file will be enqueued)", () => {
    const f = { name: "a.jpg", size: 100, lastModified: 1 };
    expect(shouldSkipAsDuplicate(f, 7)).toBe(false);
  });

  test("IE-DUP-2: fingerprint in index within TTL — returns true", () => {
    // Current formula is `<size>|<lastModified>|<name>` (CF-FP-6 fix).
    markComplete(7, "100|1|a.jpg");
    const f = { name: "a.jpg", size: 100, lastModified: 1 };
    expect(shouldSkipAsDuplicate(f, 7)).toBe(true);
  });

  test("IE-DUP-3: fingerprint in index but expired — returns false", () => {
    const DAY = 24 * 60 * 60 * 1000;
    // Seed directly with a stale ts.
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([{ fp: "100|1|a.jpg", ts: Date.now() - 8 * DAY }]),
    );
    const f = { name: "a.jpg", size: 100, lastModified: 1 };
    expect(shouldSkipAsDuplicate(f, 7)).toBe(false);
  });

  test("IE-DUP-4: null projectId — short-circuits to false (still enqueued)", () => {
    const f = { name: "a.jpg", size: 100, lastModified: 1 };
    expect(shouldSkipAsDuplicate(f, null)).toBe(false);
    expect(shouldSkipAsDuplicate(f, undefined)).toBe(false);
  });

  test("IE-DUP-5: multiple duplicate files — helper returns true for each independently", () => {
    markComplete(7, "100|1|a.jpg");
    markComplete(7, "200|2|b.jpg");
    const a = { name: "a.jpg", size: 100, lastModified: 1 };
    const b = { name: "b.jpg", size: 200, lastModified: 2 };
    expect(shouldSkipAsDuplicate(a, 7)).toBe(true);
    expect(shouldSkipAsDuplicate(b, 7)).toBe(true);
  });

  test("IE-DUP-6: all files in a drop are duplicates — helper true for all", () => {
    markComplete(7, "100|1|a.jpg");
    markComplete(7, "200|2|b.jpg");
    markComplete(7, "300|3|c.jpg");
    const drop = [
      { name: "a.jpg", size: 100, lastModified: 1 },
      { name: "b.jpg", size: 200, lastModified: 2 },
      { name: "c.jpg", size: 300, lastModified: 3 },
    ];
    const decisions = drop.map((f) => shouldSkipAsDuplicate(f, 7));
    expect(decisions).toEqual([true, true, true]);
  });

  test("IE-DUP-7: mixed new + duplicate drop — only duplicates return true", () => {
    markComplete(7, "100|1|old.jpg");
    const mixed = [
      { name: "old.jpg", size: 100, lastModified: 1 },
      { name: "new.jpg", size: 100, lastModified: 1 },
      { name: "also-new.jpg", size: 100, lastModified: 1 },
    ];
    const decisions = mixed.map((f) => shouldSkipAsDuplicate(f, 7));
    expect(decisions).toEqual([true, false, false]);
  });
});
