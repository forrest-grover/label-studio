"""Finalize-upload signal receiver.

When tus has assembled a complete temp file we mint a ``FileUpload`` row using
``create_file_upload`` — the same helper the legacy ``POST /api/projects/:pk/import``
endpoint uses — so the downstream Import / reimport flow sees an identical row.
"""

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
    if not fingerprint:
        return None
    hours = int(getattr(settings, 'TUS_SERVER_DEDUP_WINDOW_HOURS', 24))
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
    # before (no breakage, no dedup benefit).
    fingerprint = metadata.get('lsFingerprint') or None

    if not project_id:
        logger.error('tus finalize: missing projectId in metadata for %s', resource_id)
        _safe_remove(upload_file_path)
        return

    try:
        project = Project.objects.get(pk=int(project_id))
    except Project.DoesNotExist:
        logger.error('tus finalize: project %s not found (resource %s)', project_id, resource_id)
        _safe_remove(upload_file_path)
        return

    # TUS-005: server-side idempotency. If the same (project, fingerprint) was
    # finalized recently, reuse that row and drop the newly-assembled temp file
    # — the client just gets back the existing FileUpload id via the same
    # .done-marker channel, so the rest of the import flow is indistinguishable
    # from a first-time upload.
    existing = _find_existing_fileupload(int(project_id), fingerprint)
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
    """
    try:
        done_path = os.path.join(settings.TUS_UPLOAD_DIR, f'{resource_id}.done')
        with open(done_path, 'w', encoding='utf-8') as f:
            f.write(str(file_upload_id))
    except OSError:
        logger.warning('tus finalize: failed to write .done marker for %s', resource_id)


def _safe_remove(path):
    if not path:
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        logger.warning('tus finalize: failed to remove temp file %s', path)


__all__ = ['on_tus_upload_finished']
