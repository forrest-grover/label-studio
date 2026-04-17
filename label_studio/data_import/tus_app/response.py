"""Tus HTTP response helper."""

from django.conf import settings
from django.http import HttpResponse

from . import tus_api_extensions, tus_api_version, tus_api_version_supported


class TusResponse(HttpResponse):
    """HttpResponse subclass that always sets the tus protocol headers."""

    @classmethod
    def _base_headers(cls):
        return {
            'Tus-Resumable': tus_api_version,
            'Tus-Version': ','.join(tus_api_version_supported),
            'Tus-Extension': ','.join(tus_api_extensions),
            'Tus-Max-Size': getattr(settings, 'TUS_MAX_SIZE', 2 * 1024 * 1024 * 1024),
            'Access-Control-Expose-Headers': (
                'Tus-Resumable,Upload-Length,Upload-Metadata,Location,Upload-Offset'
            ),
            'Access-Control-Allow-Headers': (
                'Tus-Resumable,Upload-Length,Upload-Metadata,Location,Upload-Offset,'
                'Content-Type,Authorization,X-CSRFToken'
            ),
            'Access-Control-Allow-Methods': 'PATCH,HEAD,GET,POST,OPTIONS,DELETE',
            'Cache-Control': 'no-store',
        }

    def __init__(self, extra_headers=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for key, value in self._base_headers().items():
            self[key] = value
        if extra_headers:
            for key, value in extra_headers.items():
                self[key] = value
