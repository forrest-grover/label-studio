"""Finalize-upload signal receiver.

When tus has assembled a complete temp file we mint a ``FileUpload`` row using
``create_file_upload`` — the same helper the legacy ``POST /api/projects/:pk/import``
endpoint uses — so the downstream Import / reimport flow sees an identical row.
"""

import logging
import os

from django.core.files import File
from django.dispatch import receiver

from data_import.uploader import create_file_upload
from projects.models import Project

from .signals import tus_upload_finished_signal

logger = logging.getLogger(__name__)


@receiver(tus_upload_finished_signal)
def on_tus_upload_finished(sender, **kwargs):
    metadata = kwargs.get('metadata') or {}
    upload_file_path = kwargs.get('upload_file_path')
    user = kwargs.get('user')
    resource_id = kwargs.get('resource_id')
    filename = metadata.get('filename') or (kwargs.get('filename') or 'upload.bin')
    project_id = metadata.get('projectId')

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

    try:
        fh = open(upload_file_path, 'rb')
        try:
            wrapper = File(fh, name=filename)
            file_upload = create_file_upload(user, project, wrapper)
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
    try:
        from django.conf import settings as _s
        done_path = os.path.join(_s.TUS_UPLOAD_DIR, f'{resource_id}.done')
        with open(done_path, 'w', encoding='utf-8') as f:
            f.write(str(file_upload.id))
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
