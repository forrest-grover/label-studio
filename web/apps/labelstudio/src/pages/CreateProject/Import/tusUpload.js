/**
 * tus-js-client wrapper used by the Import page.
 *
 * Design reference: UPLOAD_FIX_DESIGN.md §A2–A4.
 *
 * Each file becomes one `tus.Upload` instance dispatched through a PQueue
 * (concurrency = CONCURRENCY). Chunks are 10 MB so a 2 GB file is 200 chunks.
 * Successful uploads fetch their FileUpload row id via the small companion
 * endpoint `/tus/resumable/<id>/file-upload-id` (see views_extra.py).
 */

import * as tus from "tus-js-client";
import PQueue from "p-queue";
import { fingerprintForFile, markComplete } from "./completedFingerprints";

export const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB — see design doc §A3
export const CONCURRENCY = 4; // §A2
export const RETRY_DELAYS = [1000, 2000, 4000]; // §A2

/**
 * Fetch the server-side ``FileUpload`` row id that was created when a tus
 * upload finalized. The marker endpoint self-cleans on read.
 */
export async function fetchFileUploadId(resourceUrl) {
  const url = `${resourceUrl.replace(/\/$/, "")}/file-upload-id`;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`tus: file-upload-id lookup failed (${res.status})`);
  }
  const body = await res.json();
  if (!body || body.file_upload_id == null) {
    throw new Error("tus: server did not return file_upload_id");
  }
  return body.file_upload_id;
}

/**
 * Upload one File via tus. Returns a Promise that resolves to `{ file,
 * fileUploadId, resourceUrl }` on success. Progress ticks are relayed via
 * onProgress(file, bytesUploaded, bytesTotal).
 *
 * If `previousUpload` is passed, tus-js-client will try to resume from the
 * stored URL before creating a new upload — used by the Resume UX (§A4).
 */
export function uploadFileTus({
  file,
  projectId,
  onProgress,
  abortSignal,
  previousUpload = null,
}) {
  return new Promise((resolve, reject) => {
    let upload;
    let lastReportedUrl = null;

    const opts = {
      endpoint: `/tus/projects/${projectId}/`,
      chunkSize: CHUNK_SIZE,
      retryDelays: RETRY_DELAYS,
      removeFingerprintOnSuccess: true,
      // tus-js-client persists (fingerprint -> {uploadUrl, size, metadata}) in
      // localStorage automatically. `storeFingerprintForResuming` is already
      // default-true; we just also maintain a per-project index for the banner
      // (see tusResume.js).
      metadata: {
        filename: file.name,
        filetype: file.type || "application/octet-stream",
        projectId: String(projectId),
      },
      headers: {
        // Session cookie is sent automatically (same-origin). tus-js-client
        // does not otherwise include credentials; see `fetch` wrapper below.
      },
      onBeforeRequest(req) {
        // Ensure the browser attaches the session cookie to every chunk
        // PATCH. tus-js-client's default XHRHttpStack uses `withCredentials`
        // when this flag is set on the stack — but setting per-request is
        // safer across client versions.
        try {
          req.getUnderlyingObject().withCredentials = true;
        } catch (_) {
          /* not XHR (e.g. node tests); ignore */
        }
      },
      onProgress(bytesUploaded, bytesTotal) {
        onProgress?.(file, bytesUploaded, bytesTotal);
      },
      onSuccess: async () => {
        try {
          // Record completion BEFORE tus-js-client's `removeFingerprintOnSuccess`
          // wipes its own fingerprint entry. The post-success localStorage
          // cleanup is synchronous in tus-js-client, but we run it in this
          // ordering regardless so the write is never racing the cleanup (see
          // TUS-001). The key here is independent of tus's internal
          // fingerprint — it's `<name>:<size>:<lastModified>` so we can
          // reproduce it from a raw File object at enqueue time.
          try {
            markComplete(projectId, fingerprintForFile(file));
          } catch (_) {
            /* best-effort; never fail an upload over a localStorage quirk */
          }
          // Final URL is stored on the upload instance once the CREATE resolved.
          const url = upload.url;
          lastReportedUrl = url;
          const fileUploadId = await fetchFileUploadId(url);
          resolve({ file, fileUploadId, resourceUrl: url });
        } catch (err) {
          reject(err);
        }
      },
      onError: (err) => {
        err.file = file;
        err.resourceUrl = lastReportedUrl || upload?.url || null;
        reject(err);
      },
    };

    upload = new tus.Upload(file, opts);

    const start = async () => {
      if (previousUpload) {
        upload.resumeFromPreviousUpload(previousUpload);
      } else {
        try {
          const prior = await upload.findPreviousUploads();
          if (prior && prior.length > 0) {
            upload.resumeFromPreviousUpload(prior[0]);
          }
        } catch (_) {
          /* best-effort; ignore */
        }
      }
      upload.start();
    };

    start().catch(reject);

    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          try {
            upload.abort();
          } catch (_) {
            /* ignore */
          }
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

/**
 * Build a fresh PQueue. Instantiated per Import session so that multiple
 * drag-drops don't pile up in a global queue.
 */
export function createUploadQueue() {
  return new PQueue({ concurrency: CONCURRENCY });
}
