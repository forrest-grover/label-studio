/**
 * Unit tests for tusUpload.js — the tus-js-client wrapper.
 *
 * Covers TESTING-STATE-MATRIX section 8: TU-FP-1, TU-FP-2. We mock the
 * tus-js-client `Upload` constructor and assert the `opts.metadata` object
 * passed to it contains the `lsFingerprint` field, which must equal the
 * output of `fingerprintForFile(file)` (the shared helper that also feeds
 * the client-side dedup index).
 */

// Shared capture slot — the mocked Upload constructor writes the opts it
// received here so each test can introspect them.
const captured = { file: null, opts: null, instance: null };

jest.mock("tus-js-client", () => {
  class FakeUpload {
    constructor(file, opts) {
      captured.file = file;
      captured.opts = opts;
      captured.instance = this;
      this.url = null;
    }
    async findPreviousUploads() {
      return [];
    }
    resumeFromPreviousUpload(_prev) {
      /* no-op */
    }
    start() {
      /* no-op — the unit tests only care about construction-time metadata */
    }
    abort() {
      /* no-op */
    }
  }
  return { Upload: FakeUpload };
});

const { uploadFileTus } = require("./tusUpload");
const { fingerprintForFile } = require("./completedFingerprints");

describe("tusUpload — fingerprint metadata injection (TU-FP-*)", () => {
  beforeEach(() => {
    captured.file = null;
    captured.opts = null;
    captured.instance = null;
  });

  test("TU-FP-1: normal File — metadata.lsFingerprint equals fingerprintForFile(file)", () => {
    const file = { name: "a.jpg", size: 100, lastModified: 12345, type: "image/jpeg" };
    // uploadFileTus returns a never-resolving Promise in this mock (no
    // onSuccess fires). We don't await it — we just need the constructor
    // call side-effect.
    uploadFileTus({ file, projectId: 7, onProgress: () => {} });

    expect(captured.opts).not.toBeNull();
    expect(captured.opts.endpoint).toBe("/tus/projects/7/");
    expect(captured.opts.metadata).toBeDefined();
    expect(captured.opts.metadata.filename).toBe("a.jpg");
    expect(captured.opts.metadata.projectId).toBe("7");
    // The load-bearing invariant: `lsFingerprint` is exactly the client's
    // dedup helper output. Hardcoding the expected string would couple this
    // test to the CF-FP-6 format; delegate to the helper so the test tracks
    // the formula automatically.
    expect(captured.opts.metadata.lsFingerprint).toBe(fingerprintForFile(file));
  });

  test("TU-FP-2: File with no lastModified — lsFingerprint falls back to 0 for lm", () => {
    const file = { name: "b.png", size: 200, type: "image/png" /* no lastModified */ };
    uploadFileTus({ file, projectId: 42, onProgress: () => {} });

    expect(captured.opts.metadata.lsFingerprint).toBe(fingerprintForFile(file));
    // Belt-and-braces: the helper must emit a 0 for the missing lm slot.
    // Current format is `<size>|<lastModified>|<name>` (CF-FP-6).
    expect(captured.opts.metadata.lsFingerprint).toBe("200|0|b.png");
  });
});
