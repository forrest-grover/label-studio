"""DRF-authed tus 1.0.0 upload endpoints.

We subclass DRF's ``APIView`` so the existing ``DEFAULT_AUTHENTICATION_CLASSES``
(token + session + JWT) apply. The endpoints are scoped by ``project_id`` so
that per-project permission checks can be enforced on creation.
"""

import base64
import logging

from django.conf import settings
from projects.models import Project
from rest_framework.authentication import (
    BasicAuthentication,
    SessionAuthentication,
    TokenAuthentication,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from .response import TusResponse
from .signals import tus_upload_finished_signal
from .tusfile import FilenameGenerator, TusChunk, TusFile

logger = logging.getLogger(__name__)

# Characters forbidden in upload filenames. Everything else is allowed — if the
# client sends something funky we fall back to a random name.
_FILENAME_BLOCKLIST = set('\0/\\:*?"<>|')


def _is_safe_filename(name: str) -> bool:
    if not name or len(name) > 255:
        return False
    return not any(ch in _FILENAME_BLOCKLIST for ch in name)


def _parse_upload_metadata(header_value: str) -> dict:
    """Parse the tus ``Upload-Metadata`` header into a dict of decoded strings."""
    metadata = {}
    if not header_value:
        return metadata
    for pair in header_value.split(','):
        parts = pair.strip().split(' ', 1)
        key = parts[0]
        if not key:
            continue
        if len(parts) == 2:
            try:
                value = base64.b64decode(parts[1]).decode('utf-8', errors='replace')
            except Exception:
                value = ''
        else:
            value = ''
        metadata[key] = value
    return metadata


class TusSessionAuthentication(SessionAuthentication):
    """Session auth without CSRF enforcement (tus PATCH cannot send cookies easily;
    we rely on DRF Token auth from the SPA, which is already the main path)."""

    def enforce_csrf(self, request):
        return  # no-op; see A3 in UPLOAD_FIX_DESIGN.md


class _TusViewBase(APIView):
    authentication_classes = [TokenAuthentication, TusSessionAuthentication, BasicAuthentication]
    permission_classes = [IsAuthenticated]
    http_method_names = ['options', 'head', 'post', 'patch', 'delete']

    # DRF parses request.body for us, but we want raw bytes on PATCH.
    parser_classes: list = []

    def get_permissions(self):
        # OPTIONS is a protocol-discovery request in tus (and the CORS preflight
        # for browsers). It MUST succeed without auth and with the tus headers
        # attached — otherwise the client refuses to start the upload.
        if self.request.method == 'OPTIONS':
            return []
        return super().get_permissions()

    def get_authenticators(self):
        if self.request and getattr(self.request, 'method', None) == 'OPTIONS':
            return []
        return super().get_authenticators()

    def handle_exception(self, exc):
        # Convert any DRF/Django exception into a tus-headered response so the
        # client gets the protocol metadata even on auth/permission failures.
        from rest_framework import exceptions as drf_exceptions

        status_code = 500
        if isinstance(exc, drf_exceptions.NotAuthenticated):
            status_code = 401
        elif isinstance(exc, drf_exceptions.PermissionDenied):
            status_code = 403
        elif isinstance(exc, drf_exceptions.APIException):
            status_code = exc.status_code
        logger.warning('tus: request failed with %s: %s', status_code, exc)
        return TusResponse(status=status_code, content=str(exc))

    def finalize_response(self, request, response, *args, **kwargs):
        # APIView adds its own Vary / renderers; don't let that mangle tus headers.
        return response


class TusProjectCreateView(_TusViewBase):
    """POST /tus/projects/<project_id>/  — tus "creation" extension."""

    def options(self, request, project_id):
        return TusResponse(status=204)

    def post(self, request, project_id):
        # Validate project access — same permission check as the regular import API.
        try:
            project = Project.objects.get(pk=project_id)
        except Project.DoesNotExist:
            return TusResponse(status=404, content='Project not found')

        if not project.has_permission(request.user):
            return TusResponse(status=403, content='Forbidden')

        file_size = int(request.META.get('HTTP_UPLOAD_LENGTH', '0'))
        if file_size <= 0:
            return TusResponse(status=400, content='Upload-Length required')
        if file_size > getattr(settings, 'TUS_MAX_SIZE', 2 * 1024 * 1024 * 1024):
            return TusResponse(status=413, content='File too large')

        metadata = _parse_upload_metadata(request.META.get('HTTP_UPLOAD_METADATA', ''))
        filename = metadata.get('filename') or ''
        if not _is_safe_filename(filename):
            filename = FilenameGenerator().filename
            metadata['filename'] = filename

        # Pin the project id in metadata so the finalize signal can route the row
        # regardless of what the client sent.
        metadata['projectId'] = str(project.pk)
        metadata['userId'] = str(request.user.pk)

        tus_file = TusFile.create_initial_file(metadata, file_size, user_id=request.user.pk)

        location = f'/tus/resumable/{tus_file.resource_id}'
        logger.info(
            'tus: created upload %s project=%s size=%s filename=%s user=%s',
            tus_file.resource_id, project.pk, file_size, filename, request.user.pk,
        )
        return TusResponse(
            status=201,
            extra_headers={'Location': location, 'Upload-Offset': '0'},
        )


class TusResourceView(_TusViewBase):
    """HEAD/PATCH/DELETE /tus/resumable/<resource_id>"""

    def options(self, request, resource_id):
        return TusResponse(status=204)

    def head(self, request, resource_id):
        tus_file = TusFile(str(resource_id))
        if tus_file.offset is None:
            return TusResponse(status=404)
        # Enforce that only the owner of the upload can inspect it.
        if tus_file.user_id != request.user.pk:
            return TusResponse(status=403)
        return TusResponse(
            status=200,
            extra_headers={
                'Upload-Offset': tus_file.offset,
                'Upload-Length': tus_file.file_size,
            },
        )

    def patch(self, request, resource_id):
        tus_file = TusFile(str(resource_id))
        if not tus_file.is_valid():
            return TusResponse(status=410, content='Gone')
        if tus_file.user_id != request.user.pk:
            return TusResponse(status=403)

        if request.content_type and request.content_type.lower() != 'application/offset+octet-stream':
            return TusResponse(status=415, content='Unsupported Media Type')

        chunk = TusChunk(request)
        if chunk.offset != tus_file.offset:
            return TusResponse(status=409, content='Offset mismatch')
        if chunk.offset + chunk.chunk_size > tus_file.file_size:
            return TusResponse(status=413, content='Chunk exceeds file size')

        try:
            tus_file.write_chunk(chunk=chunk)
        except IOError:
            logger.exception('tus: write failure for %s', resource_id)
            return TusResponse(status=500)

        if tus_file.is_complete():
            try:
                tus_upload_finished_signal.send(
                    sender=self.__class__,
                    metadata=tus_file.metadata,
                    filename=tus_file.metadata.get('filename', ''),
                    upload_file_path=tus_file.get_path(),
                    file_size=tus_file.file_size,
                    user=request.user,
                    resource_id=tus_file.resource_id,
                )
            finally:
                tus_file.clean()
                # Temp file is removed by the receiver after FileUpload row is created.

        return TusResponse(status=204, extra_headers={'Upload-Offset': tus_file.offset})

    def delete(self, request, resource_id):
        tus_file = TusFile(str(resource_id))
        if not tus_file.is_valid() or tus_file.user_id != request.user.pk:
            return TusResponse(status=404)
        tus_file.terminate()
        return TusResponse(status=204)
