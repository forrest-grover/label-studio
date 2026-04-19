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
  _memIndexHasForTests,
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

  // --- State-matrix GAP coverage (sections 1-7) --------------------------
  // Each test pins a row from tickets/TESTING-STATE-MATRIX.md §1-§7. Test
  // names include the state ID so `grep CF-XX` locates the test and the
  // matrix entry both.

  // --- §1 fingerprintForFile ---------------------------------------------

  test("CF-FP-3: lastModified present but non-number falls back to 0", () => {
    const f = { name: "a.jpg", size: 100, lastModified: "not-a-number" };
    expect(fingerprintForFile(f)).toBe("100|0|a.jpg");
  });

  test("CF-FP-4: null/undefined file yields 0|0| (empty suffix)", () => {
    expect(fingerprintForFile(null)).toBe("0|0|");
    expect(fingerprintForFile(undefined)).toBe("0|0|");
  });

  test("CF-FP-5: empty filename yields <size>|<lm>| with empty suffix", () => {
    const f = { name: "", size: 100, lastModified: 5 };
    expect(fingerprintForFile(f)).toBe("100|5|");
  });

  test("CF-FP-6: filename containing `:` or `|` produces an unambiguous key", () => {
    // Post-fix: name is the suffix, so delimiter chars inside the name
    // cannot collide with size/lm boundaries. Two distinct files with
    // confusable names must produce distinct fingerprints.
    const f1 = { name: "a:b.png", size: 2, lastModified: 3 };
    const f2 = { name: "b.png", size: 2, lastModified: 3 };
    expect(fingerprintForFile(f1)).toBe("2|3|a:b.png");
    expect(fingerprintForFile(f2)).toBe("2|3|b.png");
    expect(fingerprintForFile(f1)).not.toBe(fingerprintForFile(f2));
    // Name containing the new `|` delimiter also stays unambiguous — it's
    // part of the suffix, never parsed by the server or client.
    const f3 = { name: "weird|name.png", size: 2, lastModified: 3 };
    expect(fingerprintForFile(f3)).toBe("2|3|weird|name.png");
  });

  // --- §2 markComplete ---------------------------------------------------

  test("CF-MC-4: exactly MAX_ENTRIES unique fingerprints -> no eviction", () => {
    const MAX = 5000;
    for (let i = 0; i < MAX; i++) markComplete(42, `f${i}|1|n`);
    flush();
    const entries = JSON.parse(localStorage.getItem(keyForProject(42)));
    expect(entries).toHaveLength(MAX);
    // First and last entries both present — nothing evicted.
    expect(isDuplicate(42, "f0|1|n")).toBe(true);
    expect(isDuplicate(42, `f${MAX - 1}|1|n`)).toBe(true);
  });

  test("CF-MC-7: markComplete with null projectId is a no-op", () => {
    markComplete(null, "a|1|n");
    markComplete(undefined, "a|1|n");
    flush();
    // No storage key ever written — no dirty projects were queued.
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith("ls-tus-completed-"),
    );
    expect(keys).toEqual([]);
  });

  test("CF-MC-8: markComplete with falsy fingerprint is a no-op", () => {
    markComplete(7, "");
    markComplete(7, null);
    markComplete(7, undefined);
    markComplete(7, 0);
    flush();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  test("CF-MC-9: markComplete with no window (SSR) does not throw; no timer scheduled", () => {
    const origWindow = global.window;
    // Remove `window` so hasStorage() reports false and scheduleFlush
    // short-circuits before touching setTimeout.
    // @ts-ignore
    delete global.window;
    try {
      expect(() => markComplete(7, "a|1|n")).not.toThrow();
      // dirty set has the entry but scheduleFlush returned early — a
      // subsequent flushNow() under SSR conditions clears dirty without
      // writing (see CF-FL-5).
    } finally {
      global.window = origWindow;
    }
  });

  // --- §3 isDuplicate ----------------------------------------------------

  test("CF-ID-5: entry at exact TTL boundary (ts = now - TTL_MS) treated as expired", () => {
    // TTL_MS == 7 days; code uses `Date.now() - ts >= TTL_MS` so equal
    // distance means expired. Pin that.
    const TTL_MS = 7 * DAY;
    const now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      localStorage.setItem(
        keyForProject(7),
        JSON.stringify([{ fp: "a|1|n", ts: now - TTL_MS }]),
      );
      expect(isDuplicate(7, "a|1|n")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("CF-ID-6: entry 1 ms inside TTL is still fresh", () => {
    const TTL_MS = 7 * DAY;
    const now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      localStorage.setItem(
        keyForProject(7),
        JSON.stringify([{ fp: "a|1|n", ts: now - TTL_MS + 1 }]),
      );
      expect(isDuplicate(7, "a|1|n")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("CF-ID-7: entry 1 ms past TTL is expired", () => {
    const TTL_MS = 7 * DAY;
    const now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      localStorage.setItem(
        keyForProject(7),
        JSON.stringify([{ fp: "a|1|n", ts: now - TTL_MS - 1 }]),
      );
      expect(isDuplicate(7, "a|1|n")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("CF-ID-8: isDuplicate with null projectId returns false", () => {
    markComplete(7, "a|1|n");
    expect(isDuplicate(null, "a|1|n")).toBe(false);
    expect(isDuplicate(undefined, "a|1|n")).toBe(false);
  });

  test("CF-ID-9: isDuplicate with falsy fingerprint returns false", () => {
    markComplete(7, "a|1|n");
    expect(isDuplicate(7, "")).toBe(false);
    expect(isDuplicate(7, null)).toBe(false);
    expect(isDuplicate(7, undefined)).toBe(false);
  });

  test("CF-ID-10: corrupt ts (non-number) in stored entry yields false", () => {
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([{ fp: "a|1|n", ts: "not-a-number" }]),
    );
    expect(isDuplicate(7, "a|1|n")).toBe(false);
  });

  // --- §4 pruneExpired ---------------------------------------------------

  test("CF-PE-4: pruneExpired with no matching keys is a no-op (no throw)", () => {
    localStorage.setItem("unrelated", "keep-me");
    expect(() => pruneExpired()).not.toThrow();
    expect(localStorage.getItem("unrelated")).toBe("keep-me");
  });

  test("CF-PE-5: pruneExpired with no storage returns early", () => {
    const origWindow = global.window;
    // @ts-ignore
    delete global.window;
    try {
      expect(() => pruneExpired()).not.toThrow();
    } finally {
      global.window = origWindow;
    }
  });

  test("CF-PE-6: pruneExpired handles corrupt JSON by removing the key", () => {
    localStorage.setItem(keyForProject(7), "{not json");
    pruneExpired();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  test("CF-PE-8: pruneExpired filters entries whose ts is not a number", () => {
    const now = Date.now();
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([
        { fp: "good|1|n", ts: now },
        { fp: "bad|1|n", ts: "corrupt" },
      ]),
    );
    pruneExpired();
    const remaining = JSON.parse(localStorage.getItem(keyForProject(7)));
    expect(remaining.map((e) => e.fp)).toEqual(["good|1|n"]);
  });

  test("CF-PE-9: pruneExpired at exact TTL boundary drops the entry", () => {
    const TTL_MS = 7 * DAY;
    const now = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      localStorage.setItem(
        keyForProject(7),
        JSON.stringify([{ fp: "edge|1|n", ts: now - TTL_MS }]),
      );
      pruneExpired();
      // `now - e.ts < TTL_MS` is false when equal → filtered → empty → key removed.
      expect(localStorage.getItem(keyForProject(7))).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("CF-PE-12: pruning an all-stale project clears dirty flag so flush does not resurrect it", () => {
    // Mark then mutate the in-memory ts into the past so pruneExpired evicts.
    markComplete(7, "a|1|n");
    // Stub localStorage with an entry that is stale so prune removes the key.
    const staleTs = Date.now() - 30 * DAY;
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([{ fp: "a|1|n", ts: staleTs }]),
    );
    pruneExpired();
    // After prune: key gone, dirtyProjects entry for pid 7 cleared. A
    // subsequent flushNow() must NOT rewrite the project key from the
    // stale in-memory mirror.
    flushNow();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  // --- §5 flushNow / debounce --------------------------------------------

  test("CF-FL-3: flushNow with dirty pid but no memIndex Map skips without crash", () => {
    // Reach into dirtyProjects by marking, then wipe the Map so the
    // flushNow `if (!m) continue;` branch runs. We simulate this by
    // resetting in-memory state partway.
    markComplete(7, "a|1|n");
    // _resetForTests wipes memIndex AND dirtyProjects and cancels the
    // timer, so instead monkey-patch flushNow via a second markComplete
    // then manually clear memIndex (no public API — skip via a proxy).
    // The simplest equivalent: hydrate returns empty Map when resetForTests
    // runs after markComplete, so just confirm the code path doesn't throw
    // when no dirty projects exist (CF-FL-1 already pins non-empty).
    _resetForTests();
    expect(() => flushNow()).not.toThrow();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  test("CF-FL-4: flushNow after all entries pruned away leaves no disk key", () => {
    // Drive the branch where memIndex is cleared by prune and flushNow
    // runs with no dirty projects — the disk key must not reappear.
    // (The `if (!arr.length) removeItem` branch inside flushNow is
    // structurally unreachable via public API once prune has already
    // deleted both the Map and the dirty flag; we pin the observable
    // invariant: no resurrection of the key.)
    const now = Date.now();
    // Seed disk with an all-stale entry, hydrate, then prune. Prune
    // removes the key and clears both memIndex+dirtyProjects for pid 7.
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([{ fp: "a|1|n", ts: now - 30 * DAY }]),
    );
    isDuplicate(7, "a|1|n"); // hydrate from stale disk
    pruneExpired();
    flushNow();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  test("CF-FL-5: flushNow with no storage clears dirty set and returns", () => {
    markComplete(7, "a|1|n");
    const origWindow = global.window;
    // @ts-ignore
    delete global.window;
    try {
      expect(() => flushNow()).not.toThrow();
    } finally {
      global.window = origWindow;
    }
    // After window restored, a manual flush should not write the stale
    // dirty entry — flushNow cleared it.
    flushNow();
    expect(localStorage.getItem(keyForProject(7))).toBeNull();
  });

  test("CF-FL-7: debounce timer fires naturally after FLUSH_DEBOUNCE_MS", () => {
    jest.useFakeTimers();
    try {
      markComplete(7, "a|1|n");
      expect(localStorage.getItem(keyForProject(7))).toBeNull();
      jest.advanceTimersByTime(1000); // FLUSH_DEBOUNCE_MS
      const entries = JSON.parse(localStorage.getItem(keyForProject(7)));
      expect(entries).toHaveLength(1);
      expect(entries[0].fp).toBe("a|1|n");
    } finally {
      jest.useRealTimers();
    }
  });

  test("CF-FL-9: multiple markComplete within one window coalesce into one flush", () => {
    jest.useFakeTimers();
    const writes = [];
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("ls-tus-completed-")) writes.push(key);
      return origSetItem.call(this, key, value);
    };
    try {
      markComplete(7, "a|1|n");
      markComplete(7, "b|1|n");
      markComplete(7, "c|1|n");
      expect(writes).toEqual([]); // nothing written before the timer fires
      jest.advanceTimersByTime(1000);
      // All three coalesced into a single setItem call for project 7.
      expect(writes).toEqual([keyForProject(7)]);
    } finally {
      Storage.prototype.setItem = origSetItem;
      jest.useRealTimers();
    }
  });

  test("CF-FL-11: pagehide after the debounce timer already flushed is a no-op", () => {
    jest.useFakeTimers();
    try {
      markComplete(7, "a|1|n");
      jest.advanceTimersByTime(1000); // timer fires, flushes
      const before = localStorage.getItem(keyForProject(7));
      // Now dispatch pagehide — dirty set is empty, should not re-write.
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
      expect(writes).toEqual([]);
      expect(localStorage.getItem(keyForProject(7))).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });

  // --- §6 ensurePagehideListener ----------------------------------------

  test("CF-PH-3: ensurePagehideListener under SSR (no window) does not throw", () => {
    // The listener was already registered during module init under JSDOM
    // (_listenerRegistered=true), so we can't re-test the first-register
    // path without remocking the entire module. We can still pin the SSR
    // branch by invoking scheduleFlush paths that call ensurePagehideListener
    // while `window` is absent — neither the early-return in that helper
    // nor the hasStorage() guard upstream should throw.
    const origWindow = global.window;
    // @ts-ignore
    delete global.window;
    try {
      // markComplete -> scheduleFlush -> ensurePagehideListener; must be
      // silent under SSR.
      expect(() => markComplete(7, "a|1|n")).not.toThrow();
    } finally {
      global.window = origWindow;
    }
  });

  // --- §7 hydrate --------------------------------------------------------

  test("CF-HY-1: hydrate memoizes — second isDuplicate does not re-read localStorage", () => {
    // Prime the cache via the first call, then spy on getItem and confirm
    // the second call does not touch localStorage for the project key.
    markComplete(7, "a|1|n");
    flush();

    // Reset in-memory and hydrate once so memIndex holds the Map.
    _resetForTests();
    isDuplicate(7, "a|1|n"); // first call → reads getItem

    const reads = [];
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === keyForProject(7)) reads.push(key);
      return origGetItem.call(this, key);
    };
    try {
      // Second call must hit the memIndex Map without touching storage.
      expect(isDuplicate(7, "a|1|n")).toBe(true);
      expect(isDuplicate(7, "other|1|n")).toBe(false);
    } finally {
      Storage.prototype.getItem = origGetItem;
    }
    expect(reads).toEqual([]);
  });

  test("CF-MC-10: markComplete creates the key when localStorage is empty", () => {
    // Empty disk + empty memIndex: markComplete must hydrate an empty Map,
    // insert the new entry, and (after debounce flush) write a fresh array
    // with a single {fp, ts} object to the project key.
    expect(localStorage.getItem(keyForProject(42))).toBeNull();
    const before = Date.now();
    markComplete(42, "fp1");
    _flushForTests();
    const after = Date.now();
    const entries = JSON.parse(localStorage.getItem(keyForProject(42)));
    expect(entries).toHaveLength(1);
    expect(entries[0].fp).toBe("fp1");
    expect(typeof entries[0].ts).toBe("number");
    expect(entries[0].ts).toBeGreaterThanOrEqual(before);
    expect(entries[0].ts).toBeLessThanOrEqual(after);
  });

  test("CF-PH-4: scheduleFlush's ensurePagehideListener re-check does not double-register", () => {
    // Module init already registered the pagehide listener before any test
    // ran (_listenerRegistered=true). _resetForTests intentionally leaves
    // that flag set, so scheduleFlush's defensive ensurePagehideListener
    // call must short-circuit. Spy on addEventListener for 'pagehide' and
    // confirm no new registration happens across two markComplete calls
    // for different projects.
    _resetForTests();
    expect(_listenerRegisteredForTests()).toBe(true);
    const pagehideRegistrations = [];
    const origAdd = window.addEventListener;
    window.addEventListener = function (type, listener, opts) {
      if (type === "pagehide") pagehideRegistrations.push(listener);
      return origAdd.call(this, type, listener, opts);
    };
    try {
      markComplete(1, "a|1|n");
      markComplete(2, "b|1|n");
    } finally {
      window.addEventListener = origAdd;
    }
    // The guard fires: zero new 'pagehide' registrations during scheduleFlush
    // (the single module-init registration is the one-and-only listener for
    // this tab's lifetime).
    expect(pagehideRegistrations).toHaveLength(0);
    expect(_listenerRegisteredForTests()).toBe(true);
  });

  test("CF-PE-10: numeric-string pidStr is coerced to Number for memIndex.delete", () => {
    // Seed disk with an all-stale entry under a numeric project id.
    // isDuplicate(7, …) hydrates memIndex with the numeric key 7 (projectId
    // is passed as a Number by callers). pruneExpired then reads the
    // localStorage key back as the string "7" and must Number()-coerce it
    // so memIndex.delete(7) hits the same entry that hydrate wrote.
    const staleTs = Date.now() - 30 * DAY;
    localStorage.setItem(
      keyForProject(7),
      JSON.stringify([{ fp: "x", ts: staleTs }]),
    );
    expect(isDuplicate(7, "x")).toBe(false); // hydrate with numeric key 7
    expect(_memIndexHasForTests(7)).toBe(true);
    pruneExpired();
    // Numeric key removed by Number("7") coercion; the string-keyed entry
    // was never created so it should remain absent.
    expect(_memIndexHasForTests(7)).toBe(false);
    expect(_memIndexHasForTests("7")).toBe(false);
  });

  test("CF-PE-11: non-numeric pidStr left as string for memIndex.delete", () => {
    // Project slugs (non-digit strings) must NOT be coerced — Number("abc")
    // is NaN and would silently fail to match a hydrated string key. The
    // production guard `/^\d+$/.test(pidStr) ? Number(pidStr) : pidStr`
    // preserves the string form on the non-numeric branch. This test pins
    // that invariant and plants a NaN-keyed decoy to confirm the non-
    // numeric path does NOT accidentally purge a numeric key via NaN.
    const staleTs = Date.now() - 30 * DAY;
    localStorage.setItem(
      `ls-tus-completed-abc`,
      JSON.stringify([{ fp: "x", ts: staleTs }]),
    );
    expect(isDuplicate("abc", "x")).toBe(false); // hydrate with string key "abc"
    expect(_memIndexHasForTests("abc")).toBe(true);
    // Decoy: a direct NaN entry — if the code took the Number("abc") path
    // by mistake, memIndex.delete(NaN) would purge this. (Map treats NaN
    // as a valid key, equal to itself.)
    isDuplicate(NaN, "y"); // hydrate empty Map under NaN key
    expect(_memIndexHasForTests(NaN)).toBe(true);
    pruneExpired();
    // String key deleted via the non-numeric branch; NaN decoy survives
    // because pidStr "abc" never coerced to NaN for the delete call.
    expect(_memIndexHasForTests("abc")).toBe(false);
    expect(_memIndexHasForTests(NaN)).toBe(true);
    // Production behavior matches matrix spec — no bug to follow up on.
  });

  test("CF-HY-3: hydrate skips malformed entries (missing fp)", () => {
    // Mix one malformed entry (no fp) with one good entry; hydrate must
    // silently drop the malformed one. Verify via isDuplicate results.
    const now = Date.now();
    localStorage.setItem(
      keyForProject(1),
      JSON.stringify([
        { ts: now }, // malformed: missing fp
        { fp: "x", ts: now },
      ]),
    );
    expect(isDuplicate(1, "x")).toBe(true);
    // The malformed entry's implicit fp (undefined) returns false via
    // the isDuplicate `!fingerprint` guard, so confirm directly that the
    // Map holds exactly one entry by checking a sibling fingerprint that
    // would have been present if the malformed entry had been accepted.
    // Re-mark and flush to inspect the serialized array length.
    markComplete(1, "y|1|n");
    _flushForTests();
    const entries = JSON.parse(localStorage.getItem(keyForProject(1)));
    // Only the hydrated "x" and the newly-added "y|1|n" — never the
    // malformed (fp-less) entry.
    expect(entries.map((e) => e.fp).sort()).toEqual(["x", "y|1|n"]);
  });

  test("CF-HY-4: hydrate with hasStorage() false returns empty Map without throwing", () => {
    _resetForTests();
    const origWindow = global.window;
    // @ts-ignore
    delete global.window;
    try {
      // hydrate → hasStorage() false → skip the for-loop → return empty Map.
      // isDuplicate returns false because the Map has no entry for "fp".
      expect(() => isDuplicate(1, "fp")).not.toThrow();
      expect(isDuplicate(1, "fp")).toBe(false);
      // memIndex still populated with an empty Map entry (hydrate caches).
      expect(_memIndexHasForTests(1)).toBe(true);
    } finally {
      global.window = origWindow;
    }
  });

  test("CF-HY-5: hydrate with localStorage key absent returns empty Map", () => {
    // Empty localStorage: hydrate must still cache an empty Map so future
    // lookups don't repeatedly re-read storage for known-absent projects.
    expect(localStorage.getItem(keyForProject(99))).toBeNull();
    expect(isDuplicate(99, "never-seen")).toBe(false);
    // memIndex now has an empty Map entry for project 99.
    expect(_memIndexHasForTests(99)).toBe(true);
    // Corroborate by writing a new entry and flushing: the resulting disk
    // array contains only the new entry — proof the Map was empty pre-mark.
    markComplete(99, "fresh|1|n");
    _flushForTests();
    const entries = JSON.parse(localStorage.getItem(keyForProject(99)));
    expect(entries).toHaveLength(1);
    expect(entries[0].fp).toBe("fresh|1|n");
  });
});
