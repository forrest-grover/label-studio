import { useEffect } from "react";
import { pruneExpired } from "./completedFingerprints";

/**
 * Evict fingerprint entries older than 7 days once per Import-page mount
 * (TUS-001). Cheap — scans only `ls-tus-completed-*` keys.
 *
 * Extracted from ImportPage for testability (see TESTING-STATE-MATRIX.md
 * IE-PR-*).
 *
 * Errors are swallowed: prune-on-mount is best-effort — a localStorage
 * exception (quota, private-mode, etc.) must never block the Import page
 * from rendering. This matches the inline try/catch that already existed
 * at the call site before extraction.
 */
export function useCompletedFingerprintsPrune() {
  useEffect(() => {
    try {
      pruneExpired();
    } catch (_) {
      /* best-effort */
    }
  }, []);
}

export default useCompletedFingerprintsPrune;
