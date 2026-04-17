/**
 * Unit tests for tusResume.js — the per-project localStorage index used by
 * the Resume-on-reload banner (UPLOAD_FIX_DESIGN.md §A4).
 */

import { recordInflight, removeInflight, getInflight, clearInflight } from "./tusResume";

describe("tusResume", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("records a single inflight entry per project", () => {
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 100, loaded: 50, total: 100 });
    const entries = getInflight(7);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ fingerprint: "f1", filename: "a.jpg" });
  });

  test("dedupes on fingerprint when re-recording the same file", () => {
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 100, loaded: 10, total: 100 });
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 100, loaded: 60, total: 100 });
    const entries = getInflight(7);
    expect(entries).toHaveLength(1);
    expect(entries[0].loaded).toBe(60);
  });

  test("keeps project indices isolated", () => {
    recordInflight(1, { fingerprint: "f1", filename: "a.jpg", size: 10, loaded: 0, total: 10 });
    recordInflight(2, { fingerprint: "f2", filename: "b.jpg", size: 20, loaded: 0, total: 20 });
    expect(getInflight(1)).toHaveLength(1);
    expect(getInflight(2)).toHaveLength(1);
    expect(getInflight(1)[0].filename).toBe("a.jpg");
  });

  test("removeInflight drops only the named fingerprint", () => {
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 10, loaded: 0, total: 10 });
    recordInflight(7, { fingerprint: "f2", filename: "b.jpg", size: 10, loaded: 0, total: 10 });
    removeInflight(7, "f1");
    const entries = getInflight(7);
    expect(entries).toHaveLength(1);
    expect(entries[0].fingerprint).toBe("f2");
  });

  test("removeInflight clears the index key when nothing is left", () => {
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 10, loaded: 0, total: 10 });
    removeInflight(7, "f1");
    expect(localStorage.getItem("ls-tus-inflight::7")).toBeNull();
  });

  test("clearInflight wipes the project index", () => {
    recordInflight(7, { fingerprint: "f1", filename: "a.jpg", size: 10, loaded: 0, total: 10 });
    recordInflight(7, { fingerprint: "f2", filename: "b.jpg", size: 10, loaded: 0, total: 10 });
    clearInflight(7);
    expect(getInflight(7)).toEqual([]);
  });

  test("getInflight returns [] for projects with no entries", () => {
    expect(getInflight(42)).toEqual([]);
  });

  test("getInflight tolerates corrupt JSON in localStorage", () => {
    localStorage.setItem("ls-tus-inflight::7", "{not json");
    expect(getInflight(7)).toEqual([]);
  });
});
