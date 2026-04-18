"""Finalize-upload signal receiver.

When tus has assembled a complete temp file we mint a ``FileUpload`` row using
``create_file_upload`` — the same helper the legacy ``POST /api/projects/:pk/import``
endpoint uses — so the downstream Import / reimport flow sees an identical row.
"""

import hashlib
import logging
import os
from datetime import timedelta

from django.conf import settings
from django.core.files import File
from django.dispatch import receiver
from django.utils import timezone

from data_import.models import FileUpload
from data_import.uploader import create_file_upload
from projects.models import Project

from .signals import tus_upload_finished_signal

logger = logging.getLogger(__name__)

# FileUpload.fingerprint is `max_length=512`. The client sends a raw
# `<name>:<size>:<lastModified>` blob (see completedFingerprints.js) — a pathological
# filename longer than ~480 chars would overflow. We hash-on-receive so identical
# long names still collide deterministically for dedup and the stored value is
# always well within the column width. Also sidesteps the `:` delimiter ambiguity
# the client separately guards (CF-FP-6) — the server never re-parses the blob.
FINGERPRINT_MAX_RAW_LEN = 512


def _normalize_fingerprint(fp):
    """Coerce empty/long fingerprints to a safe, queryable form.

    Returns ``None`` for falsy input so ``_find_existing_fileupload`` short-circuits.
    For over-length inputs returns ``sha256(fp).hexdigest()`` (64 chars); short
    inputs pass through unchanged. Critically: both the writer (stamping onto the
    new FileUpload row) and the reader (``_find_existing_fileupload``) run through
    this helper, so a long-name dedup hit still resolves to the same stored value.
    """
    if not fp:
        return None
    if len(fp) > FINGERPRINT_MAX_RAW_LEN:
        return hashlib.sha256(fp.encode('utf-8')).hexdigest()
    return fp


def _find_existing_fileupload(project_id: int, fingerprint: str):
    """Return the most-recent FileUpload matching (project_id, fingerprint)
    within ``TUS_SERVER_DEDUP_WINDOW_HOURS``, or ``None``. Called on every tus
    finalize (TUS-005) to catch the XHR-in-flight-on-unload race where the
    client never sees the PATCH response and so never records the fingerprint
    in its localStorage index.

    Uses the composite `(project, fingerprint)` index added in migration 0003
    so this is a single indexed lookup regardless of how many rows the project
    has. Returning ``None`` is the happy path — dedup only kicks in on a true
    duplicate re-upload within the window.
    """
    fingerprint = _normalize_fingerprint(fingerprint)
    if not fingerprint:
        return None
    try:
        hours = int(getattr(settings, 'TUS_SERVER_DEDUP_WINDOW_HOURS', 24))
    except (TypeError, ValueError):
        # Defensive: setting misconfigured to a non-int string. Fail-open to
        # the documented default rather than raising mid-finalize — a bad
        # setting shouldn't strand the client's upload.
        logger.warning(
            'TUS_SERVER_DEDUP_WINDOW_HOURS=%r not an int; falling back to 24',
            getattr(settings, 'TUS_SERVER_DEDUP_WINDOW_HOURS', None),
        )
        hours = 24
    cutoff = timezone.now() - timedelta(hours=hours)
    return (
        FileUpload.objects.filter(
            project_id=project_id,
            fingerprint=fingerprint,
            created_at__gte=cutoff,
        )
        .order_by('-created_at')
        .first()
    )


@receiver(tus_upload_finished_signal)
def on_tus_upload_finished(sender, **kwargs):
    metadata = kwargs.get('metadata') or {}
    upload_file_path = kwargs.get('upload_file_path')
    user = kwargs.get('user')
    resource_id = kwargs.get('resource_id')
    filename = metadata.get('filename') or (kwargs.get('filename') or 'upload.bin')
    project_id = metadata.get('projectId')
    # Client-computed dedup key `<name>:<size>:<lastModified>`; may be absent
    # on older clients — in which case we simply skip dedup and behave as
    # before (no breakage, no dedup benefit). Normalized (sha256 if over the
    # column width) so downstream save() and query both use the same canonical
    # value.
    fingerprint = _normalize_fingerprint(metadata.get('lsFingerprint'))

    if not project_id:
        logger.error('tus finalize: missing projectId in metadata for %s', resource_id)
        _safe_remove(upload_file_path)
        return

    try:
        project_pk = int(project_id)
    except (TypeError, ValueError):
        # RX-ERR-3: a non-integer projectId would otherwise escape as an
        # unhandled ValueError — cleaner to log, drop the temp file, and bail
        # so the signal framework doesn't surface a 500 for a client-supplied
        # bad value.
        logger.error(
            'tus finalize: invalid projectId %r in metadata (resource %s)',
            project_id, resource_id,
        )
        _safe_remove(upload_file_path)
        return

    try:
        project = Project.objects.get(pk=project_pk)
    except Project.DoesNotExist:
        logger.error('tus finalize: project %s not found (resource %s)', project_id, resource_id)
        _safe_remove(upload_file_path)
        return

    # TUS-005: server-side idempotency. If the same (project, fingerprint) was
    # finalized recently, reuse that row and drop the newly-assembled temp file
    # — the client just gets back the existing FileUpload id via the same
    # .done-marker channel, so the rest of the import flow is indistinguishable
    # from a first-time upload.
    existing = _find_existing_fileupload(project_pk, fingerprint)
    if existing is not None:
        logger.info(
            'tus finalize: dedup hit project=%s fingerprint=%s -> reusing FileUpload id=%s '
            '(resource %s)',
            project.pk, fingerprint, existing.id, resource_id,
        )
        _safe_remove(upload_file_path)
        _write_done_marker(resource_id, existing.id)
        return

    try:
        fh = open(upload_file_path, 'rb')
        try:
            wrapper = File(fh, name=filename)
            file_upload = create_file_upload(user, project, wrapper)
            # Persist the fingerprint post-save so subsequent finalizes can
            # dedup against it. Done in a tight save(update_fields=...) to
            # avoid a second round-trip through create_file_upload's SVG-
            # cleanup branch.
            if fingerprint and file_upload.fingerprint != fingerprint:
                file_upload.fingerprint = fingerprint
                file_upload.save(update_fields=['fingerprint'])
        finally:
            fh.close()
    except Exception:
        logger.exception('tus finalize: create_file_upload failed (resource %s)', resource_id)
        _safe_remove(upload_file_path)
        raise

    # FileField copies bytes into MEDIA_ROOT/upload/<project>/... during save(),
    # so the original temp file is safe to delete now.
    _safe_remove(upload_file_path)

    logger.info(
        'tus finalize: FileUpload id=%s created for project=%s filename=%s (resource %s)',
        file_upload.id, project.pk, filename, resource_id,
    )

    # Write a .done marker next to where the temp file lived so the client can
    # retrieve the FileUpload id via the /tus/resumable/<id>/file-upload-id
    # endpoint. The marker is cleaned up by the janitor (or after it's read).
    _write_done_marker(resource_id, file_upload.id)


def _write_done_marker(resource_id, file_upload_id):
    """Write the .done sidecar marker used by the companion `file-upload-id`
    endpoint. Extracted so both the happy path and the TUS-005 dedup-hit path
    produce the same handshake — the client never needs to know whether its
    finalize was deduped.

    RX-ERR-5: if the marker write fails we re-raise. The client polls for this
    file to learn the FileUpload id; silently swallowing the OSError leaves the
    client stalling forever. Propagating surfaces the failure via the tus
    signal-sender error path (500 response) so the client retry logic can kick
    in.
    """
    try:
        done_path = os.path.join(settings.TUS_UPLOAD_DIR, f'{resource_id}.done')
        with open(done_path, 'w', encoding='utf-8') as f:
            f.write(str(file_upload_id))
    except OSError:
        logger.exception('tus finalize: failed to write .done marker for %s', resource_id)
        raise


def _safe_remove(path):
    if not path:
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        logger.warning('tus finalize: failed to remove temp file %s', path)


__all__ = ['on_tus_upload_finished']
