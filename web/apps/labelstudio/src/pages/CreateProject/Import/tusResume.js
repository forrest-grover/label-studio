/**
 * Maintain a small per-project index of in-flight tus uploads so the Import
 * page can show a "Resume N interrupted uploads" banner after a reload.
 *
 * tus-js-client already persists the upload URL keyed on file fingerprint;
 * the index below just records WHICH fingerprints belong to WHICH project so
 * we can filter on modal open. See UPLOAD_FIX_DESIGN.md §A4.
 */

const INDEX_KEY = (projectId) => `ls-tus-inflight::${projectId}`;

function safeParse(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

export function recordInflight(projectId, entry) {
  if (typeof window === "undefined" || !window.localStorage) return;
  const existing = safeParse(localStorage.getItem(INDEX_KEY(projectId)));
  // Dedup on fingerprint.
  const deduped = existing.filter((e) => e.fingerprint !== entry.fingerprint);
  deduped.push(entry);
  localStorage.setItem(INDEX_KEY(projectId), JSON.stringify(deduped));
}

export function removeInflight(projectId, fingerprint) {
  if (typeof window === "undefined" || !window.localStorage) return;
  const existing = safeParse(localStorage.getItem(INDEX_KEY(projectId)));
  const filtered = existing.filter((e) => e.fingerprint !== fingerprint);
  if (filtered.length === 0) {
    localStorage.removeItem(INDEX_KEY(projectId));
  } else {
    localStorage.setItem(INDEX_KEY(projectId), JSON.stringify(filtered));
  }
}

export function getInflight(projectId) {
  if (typeof window === "undefined" || !window.localStorage) return [];
  return safeParse(localStorage.getItem(INDEX_KEY(projectId)));
}

export function clearInflight(projectId) {
  if (typeof window === "undefined" || !window.localStorage) return;
  localStorage.removeItem(INDEX_KEY(projectId));
}
