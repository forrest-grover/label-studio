"""Orphaned tus temp-file janitor (TUS-003).

The vendored tus server writes per-upload state to ``TUS_UPLOAD_DIR`` as three
file kinds:

* ``<resource_id>.meta`` — JSON state, created on POST, updated on every PATCH.
* ``<resource_id>.data`` — sparse data file, created on POST.
* ``<resource_id>.done`` — tombstone marker written after the finalize receiver
  successfully creates a ``FileUpload`` row. The SPA reads this via
  ``/tus/resumable/<id>/file-upload-id`` and the view deletes it on read.

State-machine truths (see ``receivers.on_tus_upload_finished``):

1. On a successful PATCH that completes the upload, the receiver calls
   ``TusFile.clean()`` → removes ``.meta``, then ``_safe_remove(upload_file_path)``
   → removes ``.data``, then writes ``.done``. So the normal post-finalize
   state is: only ``.done`` present.
2. If the client abandons mid-upload, ``.meta`` and ``.data`` remain forever.
3. If the finalize receiver crashes after writing ``.meta``/``.data`` but before
   writing ``.done``, the pair is stuck — indistinguishable from case 2 by
   mtime, and correctly handled the same way (delete after TTL).
4. ``.meta`` + ``.data`` + ``.done`` all present simultaneously is only possible
   during the small window between ``tus_upload_finished_signal.send(...)`` and
   the ``clean()`` call — i.e., a few ms. We still guard against it by skipping
   any pair whose ``.done`` peer is newer than the TTL cutoff.

Ticket TUS-003 originally said "skip pairs whose .done is newer than the
``FileUpload`` row's ``created_at``". ``FileUpload`` has no ``created_at``
column (see ``data_import/models.py``), so we use the ``.done`` mtime directly
as the finalize-recency signal — it is written immediately after the row is
created, within the same receiver, so it is a strictly tighter bound.
"""

import logging
import os
import time

from django.conf import settings

logger = logging.getLogger(__name__)


def _list_meta_files(upload_dir: str):
    try:
        with os.scandir(upload_dir) as it:
            for entry in it:
                if entry.is_file() and entry.name.endswith('.meta'):
                    yield entry
    except FileNotFoundError:
        return


def _safe_unlink(path: str) -> int:
    """Remove ``path`` if present; return bytes freed (0 on failure / missing)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return 0
    try:
        os.remove(path)
    except OSError as exc:
        logger.warning('tus janitor: failed to remove %s: %s', path, exc)
        return 0
    return size


def cleanup_orphaned_tus_files(
    upload_dir: str | None = None,
    ttl_days: int | None = None,
    now: float | None = None,
) -> dict:
    """Delete stale ``.meta``/``.data`` pairs from ``TUS_UPLOAD_DIR``.

    Arguments are optional to keep the function easy to call from a management
    command, an rq job, or a test. When not supplied they default to
    ``settings.TUS_UPLOAD_DIR`` / ``settings.TUS_ORPHAN_TTL_DAYS`` /
    ``time.time()`` respectively.

    Deletion rules (see module docstring for state-machine rationale):

    * ``.meta`` mtime older than ``now - ttl_days``: candidate.
    * Candidate skipped if a paired ``.done`` marker exists AND the ``.done``
      mtime is newer than the TTL cutoff — treated as a recently finalized
      upload whose client hasn't retrieved the file-upload-id yet.
    * Otherwise, the ``.meta`` and ``.data`` pair is deleted. The ``.done``
      marker, if present, is left in place — it is cleaned up by the
      ``TusResourceResultView`` GET or by natural operator rotation.

    Returns a dict with ``scanned``, ``candidates``, ``deleted``, and
    ``bytes_freed`` counters, matching the INFO log line emitted on completion.
    """
    if upload_dir is None:
        upload_dir = settings.TUS_UPLOAD_DIR
    if ttl_days is None:
        ttl_days = int(getattr(settings, 'TUS_ORPHAN_TTL_DAYS', 7))
    if now is None:
        now = time.time()

    cutoff = now - (ttl_days * 86400)

    scanned = 0
    candidates = 0
    deleted = 0
    bytes_freed = 0

    for meta_entry in _list_meta_files(upload_dir):
        scanned += 1
        meta_path = meta_entry.path
        try:
            meta_mtime = meta_entry.stat().st_mtime
        except OSError:
            continue

        if meta_mtime >= cutoff:
            continue  # fresh, still within TTL
        candidates += 1

        # Resource id is the filename without the .meta suffix.
        resource_id = meta_entry.name[: -len('.meta')]
        data_path = os.path.join(upload_dir, f'{resource_id}.data')
        done_path = os.path.join(upload_dir, f'{resource_id}.done')

        # Skip if a .done marker is fresh — upload finalized recently and the
        # receiver's cleanup may not have run yet, or we're inside the tiny
        # post-signal-pre-clean window.
        if os.path.exists(done_path):
            try:
                done_mtime = os.path.getmtime(done_path)
            except OSError:
                done_mtime = 0.0
            if done_mtime >= cutoff:
                logger.debug(
                    'tus janitor: skipping %s; .done peer is fresh (mtime=%s, cutoff=%s)',
                    resource_id, done_mtime, cutoff,
                )
                continue

        freed = _safe_unlink(meta_path) + _safe_unlink(data_path)
        if freed or not (os.path.exists(meta_path) or os.path.exists(data_path)):
            deleted += 1
            bytes_freed += freed
            logger.debug(
                'tus janitor: removed pair %s (bytes_freed=%d)', resource_id, freed,
            )

    logger.info(
        'tus janitor: scanned=%d candidates=%d deleted=%d bytes_freed=%d',
        scanned, candidates, deleted, bytes_freed,
    )
    return {
        'scanned': scanned,
        'candidates': candidates,
        'deleted': deleted,
        'bytes_freed': bytes_freed,
    }


__all__ = ['cleanup_orphaned_tus_files']
