"""Tus resumable-upload state + chunk writing.

State is stored on the shared TUS_UPLOAD_DIR volume so that subsequent PATCH
requests can find the right file even when routed to a different uWSGI worker
(Label Studio OSS runs without a shared Redis/Memcached).

Layout::

    TUS_UPLOAD_DIR/
        <resource_id>.data   # sparse file, receives chunk bytes
        <resource_id>.meta   # JSON: {filename, file_size, offset, metadata, user_id}

The legacy django-tus cache-based design would have worked with a shared
Redis, but the OSS deploy uses local-memory cache which is per-worker.
"""

import json
import logging
import os
import random
import string
import uuid

from django.conf import settings

logger = logging.getLogger(__name__)


def _data_path(resource_id: str) -> str:
    return os.path.join(settings.TUS_UPLOAD_DIR, f'{resource_id}.data')


def _meta_path(resource_id: str) -> str:
    return os.path.join(settings.TUS_UPLOAD_DIR, f'{resource_id}.meta')


class FilenameGenerator:
    def __init__(self, filename: str = ''):
        self.filename = filename or self.random_string()

    @classmethod
    def random_string(cls, length: int = 16) -> str:
        alphabet = string.ascii_letters + string.digits
        return ''.join(random.choice(alphabet) for _ in range(length))


class TusChunk:
    def __init__(self, request):
        self.META = request.META
        self.offset = int(request.META.get('HTTP_UPLOAD_OFFSET', 0))
        self.chunk_size = int(request.META.get('CONTENT_LENGTH', 0) or 0)
        self.content = request.body


def _read_meta(resource_id: str):
    try:
        with open(_meta_path(resource_id), 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _write_meta(resource_id: str, meta: dict):
    path = _meta_path(resource_id)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(meta, f)
    os.replace(tmp, path)


class TusFile:
    """Represents an in-progress tus upload backed by a temp file on disk."""

    def __init__(self, resource_id: str):
        self.resource_id = resource_id
        meta = _read_meta(resource_id) or {}
        self.filename = meta.get('filename')
        self.file_size = meta.get('file_size')
        self.metadata = meta.get('metadata') or {}
        self.offset = meta.get('offset')
        self.user_id = meta.get('user_id')

    @staticmethod
    def create_initial_file(metadata, file_size, user_id):
        resource_id = str(uuid.uuid4())
        meta = {
            'filename': metadata.get('filename', ''),
            'file_size': int(file_size),
            'offset': 0,
            'metadata': metadata,
            'user_id': int(user_id),
        }
        _write_meta(resource_id, meta)

        tus_file = TusFile(resource_id)
        tus_file.write_init_file()
        return tus_file

    def is_valid(self) -> bool:
        return self.filename is not None and os.path.lexists(self.get_path())

    def get_path(self) -> str:
        return _data_path(self.resource_id)

    def _write_file(self, path: str, offset: int, content: bytes):
        with open(path, 'r+b') as f:
            f.seek(offset)
            f.write(content)

    def write_init_file(self):
        # Pre-allocate a sparse file of the target size so future PATCHes can
        # seek-and-write to arbitrary offsets.
        try:
            with open(self.get_path(), 'wb') as f:
                if self.file_size and self.file_size > 0:
                    f.seek(self.file_size - 1)
                    f.write(b'\0')
        except IOError:
            logger.exception('tus: unable to create init file %s', self.get_path())
            raise

    def write_chunk(self, chunk: TusChunk):
        self._write_file(self.get_path(), chunk.offset, chunk.content)
        new_offset = int(self.offset or 0) + int(chunk.chunk_size)
        self.offset = new_offset
        # Persist the new offset atomically so concurrent workers see a
        # consistent view. We re-read the meta to avoid clobbering other
        # fields if they were (unexpectedly) updated elsewhere.
        meta = _read_meta(self.resource_id) or {}
        meta['offset'] = new_offset
        _write_meta(self.resource_id, meta)

    def is_complete(self) -> bool:
        return self.offset == self.file_size

    def clean(self):
        try:
            os.remove(_meta_path(self.resource_id))
        except OSError:
            pass

    def terminate(self):
        """Delete both the on-disk temp file and its metadata."""
        for p in (_data_path(self.resource_id), _meta_path(self.resource_id)):
            try:
                if os.path.lexists(p):
                    os.remove(p)
            except OSError:
                logger.warning('tus: failed to remove %s', p)

    def __str__(self):
        return f'{self.filename} ({self.resource_id})'
