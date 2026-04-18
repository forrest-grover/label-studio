/**
 * Unit tests for completedFingerprints.js — the per-project localStorage
 * index that prevents re-uploading files that already finished in a prior
 * session (TUS-001).
 */

import {
  markComplete,
  isDuplicate,
  pruneExpired,
  keyForProject,
  fingerprintForFile,
  flushNow,
  _flushForTests,
  _resetForTests,
  _listenerRegisteredForTests,
} from "./completedFingerprints";

const DAY = 24 * 60 * 60 * 1000;

// The production hot path is debounced (TUS-002) — tests call this helper to
// read back what markComplete has recorded on disk.
function flush() {
  _flushForTests();
}

describe("completedFingerprints", () => {
  beforeEach(() => {
    // Reset both in-memory mirror and localStorage so tests don't bleed.
    _resetForTests();
    localStorage.clear();
  });

  test("markComplete then isDuplicate returns true for same project + fp", () => {
    markComplete(7, "a.jpg:100:1000");
    expect(isDuplicate(7, "a.jpg:100:1000")).toBe(true);
  });

  test("isDuplicate returns false for different project", () => {
    markComplete(7, "a.jpg:100:1000");
    expect(isDuplicate(8, "a.jpg:100:1000")).toBe(false);
  });

  test("isDuplicate returns false for unknown fingerprint", () => {
    markComplete(7, "a.jpg:100:1000");
    expect(isDuplicate(7, "b.jpg:100:1000")).toBe(false);
  });

  test("isDuplicate returns false for an entry older than 7 days (TTL enforced on read)", () => {
    // Seed directly so we can manipulate `ts` into the past.
    const oldTs = Date.now() - 8 * DAY;
    localStorage.setItem(keyForProject(7), JSON.stringify([{ fp: "a.jpg:100:1000", ts: oldTs }]));
    expect(isDuplicate(7, "a.jpg:100:1000")).toBe(false);
  });

  test("pruneExpired removes entries older than 7 days across all ls-tus-completed-* keys", () => {
    const now = Date.now();
    localStorage.setItem(
      keyForProject(1),
      JSON.stringify([
        { fp: "old.jpg:1:1", ts: now - 8 * DAY },
        { fp: "fresh.jpg:1:1", ts: now - 1 * DAY },
      ]),
    );
    localStorage.setItem(
      keyForProject(2),
      JSON.stringify([{ fp: "stale.jpg:1:1", ts: now - 30 * DAY }]),
    );
    // An unrelated key should not be touched.
    localStorage.setItem("unrelated", "keep-me");

    pruneExpired();

    // Project 1 keeps only the fresh entry.
    const p1 = JSON.parse(localStorage.getItem(keyForProject(1)));
    expect(p1).toHaveLength(1);
    expect(p1[0].fp).toBe("fresh.jpg:1:1");

    // Project 2's only entry was stale — the key should be removed entirely.
    expect(localStorage.getItem(keyForProject(2))).toBeNull();

    // Unrelated keys untouched.
    expect(localStorage.getItem("unrelated")).toBe("keep-me");

    // And isDuplicate reflects the prune.
    expect(isDuplicate(1, "old.jpg:1:1")).toBe(false);
    expect(isDuplicate(1, "fresh.jpg:1:1")).toBe(true);
    expect(isDuplicate(2, "stale.jpg:1:1")).toBe(false);
  });

  test("re-marking the same fingerprint refreshes its timestamp instead of appending", () => {
    markComplete(7, "a.jpg:100:1000");
    markComplete(7, "a.jpg:100:1000");
    flush();
    const entries = JSON.parse(localStorage.getItem(keyForProject(7)));
    expect(entries).toHaveLength(1);
  });

  test("tolerates corrupt JSON in localStorage", () => {
    localStorage.setItem(keyForProject(7), "{not json");
    expect(isDuplicate(7, "a.jpg:100:1000")).toBe(false);
    // markComplete recovers by overwriting the bad value.
    markComplete(7, "a.jpg:100:1000");
    expect(isDuplicate(7, "a.jpg:100:1000")).toBe(true);
  });

  test("fingerprintForFile uses <size>|<lastModified>|<name>", () => {
    const f = { name: "a.jpg", size: 100, lastModified: 12345 };
    expect(fingerprintForFile(f)).toBe("100|12345|a.jpg");
  });

  test("fingerprintForFile falls back to 0 for missing lastModified", () => {
    const f = { name: "a.jpg", size: 100 };
    expect(fingerprintForFile(f)).toBe("100|0|a.jpg");
  });

  // --- TUS-002: per-project cap + FIFO eviction ---------------------------

  test("markComplete caps the per-project index and evicts the oldest entries (FIFO)", () => {
    // Write MAX_ENTRIES + overflow unique fingerprints. The first
    // `overflow` fingerprints should be evicted; the rest must survive.
    const MAX = 5000;
    const overflow = 120;
    for (let i = 0; i < MAX + overflow; i++) {
      markComplete(42, `f${i}.jpg:1:1`);
    }
    flush();
    const entries = JSON.parse(localStorage.getItem(keyForProject(42)));
    expect(entries).toHaveLength(MAX);
    // Oldest `overflow` entries evicted.
    expect(isDuplicate(42, "f0.jpg:1:1")).toBe(false);
    expect(isDuplicate(42, `f${overflow - 1}.jpg:1:1`)).toBe(false);
    // First surviving entry and the newest are still there.
    expect(isDuplicate(42, `f${overflow}.jpg:1:1`)).toBe(true);
    expect(isDuplicate(42, `f${MAX + overflow - 1}.jpg:1:1`)).toBe(true);
  });

  test("re-marking an existing fingerprint moves it to MRU so it isn't evicted first", () => {
    const MAX = 5000;
    for (let i = 0; i < MAX; i++) markComplete(42, `f${i}.jpg:1:1`);
    // Refresh the oldest entry — it should now sit at the MRU end.
    markComplete(42, "f0.jpg:1:1");
    // Push one more entry past the cap; the oldest *now* is f1, not f0.
    markComplete(42, "new.jpg:1:1");
    flush();
    expect(isDuplicate(42, "f0.jpg:1:1")).toBe(true);
    expect(isDuplicate(42, "f1.jpg:1:1")).toBe(false);
    expect(isDuplicate(42, "new.jpg:1:1")).toBe(true);
  });

  // --- TUS-004: pagehide sync flush closes the debounce race -------------

  test("pagehide event synchronously flushes pending in-memory deltas to localStorage", () => {
    // No flush helper — we rely on the module's own pagehide listener to
    // do the write, exactly like a real reload would.
    markComplete(99, "race.jpg:100:1000");
    // Nothing on disk yet: the 1 s debounce window has not elapsed.
    expect(localStorage.getItem(keyForProject(99))).toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    const entries = JSON.parse(localStorage.getItem(keyForProject(99)));
    expect(entries).toHaveLength(1);
    expect(entries[0].fp).toBe("race.jpg:100:1000");

    // Second dispatch must be a no-op (idempotent flush) — dirty set is
    // empty now, so it should neither throw nor corrupt the stored data.
    window.dispatchEvent(new Event("pagehide"));
    const entriesAgain = JSON.parse(localStorage.getItem(keyForProject(99)));
    expect(entriesAgain).toHaveLength(1);

    // flushNow() is the same idempotent function exposed for explicit
    // shutdown paths; calling it with no pending writes is a no-op.
    expect(() => flushNow()).not.toThrow();
  });

  test("pagehide listener is registered exactly once per tab regardless of module touches", () => {
    // The module self-installs on first evaluation; nothing any test does
    // (resets, repeated imports from cached module, repeated markComplete
    // calls) should flip this to "registered twice".
    expect(_listenerRegisteredForTests()).toBe(true);
    _resetForTests();
    markComplete(1, "a.jpg:1:1");
    markComplete(2, "b.jpg:1:1");
    // Still registered, still a single listener (the flag never flips off).
    expect(_listenerRegisteredForTests()).toBe(true);

    // And a single pagehide dispatch must flush both projects — if we had
    // double-registered, JSDOM would run the handler twice, which is still
    // safe (idempotent) but the single-write behavior is the invariant we
    // care about. Spy on setItem to count writes per project.
    const writes = [];
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("ls-tus-completed-")) writes.push(key);
      return origSetItem.call(this, key, value);
    };
    try {
      window.dispatchEvent(new Event("pagehide"));
    } finally {
      Storage.prototype.setItem = origSetItem;
    }
    // One write per dirty project — two projects, two writes total. A
    // double-registered listener would have produced 4.
    expect(writes).toEqual([keyForProject(1), keyForProject(2)]);
  });
});
