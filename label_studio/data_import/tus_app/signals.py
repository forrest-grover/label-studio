"""tus upload-finished signal.

Django 5 removed ``providing_args`` from ``Signal.__init__``; we just document the
fields the sender passes instead.
"""

import django.dispatch

# Sender: views.TusUploadView
# kwargs:
#   metadata: dict  — the tus metadata the client sent
#   filename: str   — sanitised filename
#   upload_file_path: str — absolute path to the fully-assembled temp file
#   file_size: int
#   user: User      — authenticated request user
#   resource_id: str — the tus upload resource id (UUID)
tus_upload_finished_signal = django.dispatch.Signal()
