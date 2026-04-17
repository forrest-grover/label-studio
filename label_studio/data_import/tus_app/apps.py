"""AppConfig for the vendored tus server."""

from pathlib import Path

from django.apps import AppConfig
from django.conf import settings


class TusAppConfig(AppConfig):
    name = 'data_import.tus_app'
    label = 'tus_app'
    verbose_name = 'Label Studio Tus Upload'

    def ready(self):
        # Ensure temp and destination directories exist before first request.
        Path(settings.TUS_UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        Path(settings.TUS_DESTINATION_DIR).mkdir(parents=True, exist_ok=True)
        # Import the receiver so it is connected.
        from . import receivers  # noqa: F401
