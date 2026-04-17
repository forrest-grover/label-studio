"""Label-Studio-specific extension: fetch the FileUpload id from a tus resource id.

The tus protocol itself does not give the client a way to learn the server's
downstream record id. We drop a ``<resource_id>.done`` marker in TUS_UPLOAD_DIR
inside the finalize receiver; the SPA calls this endpoint after ``onSuccess``
to retrieve the id and (optionally) clean the marker.
"""

import os

from django.conf import settings
from rest_framework.authentication import (
    SessionAuthentication,
    TokenAuthentication,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class TusResourceResultView(APIView):
    authentication_classes = [TokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def get(self, request, resource_id):
        done_path = os.path.join(settings.TUS_UPLOAD_DIR, f'{resource_id}.done')
        if not os.path.exists(done_path):
            return Response({'file_upload_id': None}, status=404)
        try:
            with open(done_path, 'r', encoding='utf-8') as f:
                file_upload_id = int(f.read().strip())
        except (OSError, ValueError):
            return Response({'file_upload_id': None}, status=404)
        # Clean up after read so the directory doesn't accumulate markers.
        try:
            os.remove(done_path)
        except OSError:
            pass
        return Response({'file_upload_id': file_upload_id})
