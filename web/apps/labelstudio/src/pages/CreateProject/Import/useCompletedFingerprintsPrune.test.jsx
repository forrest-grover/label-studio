/**
 * Mount-effect tests for useCompletedFingerprintsPrune.
 *
 * Covers TESTING-STATE-MATRIX.md IE-PR-1 through IE-PR-3.
 *
 * The hook is a thin wrapper around a mount-time `pruneExpired()` call with
 * a best-effort try/catch. These tests pin:
 *   - IE-PR-1: mount → pruneExpired() called once
 *   - IE-PR-2: pruneExpired throw → swallowed, hook mount does not crash
 *   - IE-PR-3: remount (unmount + fresh mount) → called again (idempotent)
 */

import { renderHook } from "@testing-library/react";
import * as completedFingerprints from "./completedFingerprints";
import { useCompletedFingerprintsPrune } from "./useCompletedFingerprintsPrune";

describe("useCompletedFingerprintsPrune", () => {
  let pruneSpy;

  beforeEach(() => {
    pruneSpy = jest.spyOn(completedFingerprints, "pruneExpired").mockImplementation(() => {});
  });

  afterEach(() => {
    pruneSpy.mockRestore();
  });

  test("IE-PR-1: mount → pruneExpired called exactly once", () => {
    renderHook(() => useCompletedFingerprintsPrune());
    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });

  test("IE-PR-2: pruneExpired throws → error swallowed, mount still succeeds", () => {
    pruneSpy.mockImplementation(() => {
      throw new Error("localStorage quota exceeded");
    });

    // If the hook re-threw, renderHook would propagate the error out of the
    // React render cycle and fail the test. We assert that does NOT happen.
    expect(() => {
      renderHook(() => useCompletedFingerprintsPrune());
    }).not.toThrow();

    // And the call still happened (i.e. we didn't bypass it defensively):
    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });

  test("IE-PR-3: remount calls pruneExpired again (idempotent best-effort prune)", () => {
    const { unmount } = renderHook(() => useCompletedFingerprintsPrune());
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    unmount();

    // Second mount = second pruneExpired call. Models the case of the Import
    // page being opened, closed, and reopened within the same session.
    renderHook(() => useCompletedFingerprintsPrune());
    expect(pruneSpy).toHaveBeenCalledTimes(2);
  });
});
