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
} from "./completedFingerprints";

const DAY = 24 * 60 * 60 * 1000;

describe("completedFingerprints", () => {
  beforeEach(() => {
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

  test("fingerprintForFile uses <name>:<size>:<lastModified>", () => {
    const f = { name: "a.jpg", size: 100, lastModified: 12345 };
    expect(fingerprintForFile(f)).toBe("a.jpg:100:12345");
  });

  test("fingerprintForFile falls back to 0 for missing lastModified", () => {
    const f = { name: "a.jpg", size: 100 };
    expect(fingerprintForFile(f)).toBe("a.jpg:100:0");
  });
});
