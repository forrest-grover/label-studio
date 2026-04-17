"""Vendored + adapted tus 1.0.0 server for Label Studio.

Originally derived from django-tus 0.5.0 (Apache 2.0, https://github.com/alican/django-tus).
Adapted locally because django-tus 0.5.0 does not import on Django >=5 (it passes the
`providing_args` kwarg to `django.dispatch.Signal`, which was removed in Django 4.1),
and because Label Studio needs DRF-authed endpoints integrated with its existing
FileUpload finalize flow.

Protocol:
  https://tus.io/protocols/resumable-upload.html (v1.0.0; extensions: creation, termination)
"""

default_app_config = 'data_import.tus_app.apps.TusAppConfig'

tus_api_version = '1.0.0'
tus_api_version_supported = ['1.0.0']
tus_api_extensions = ['creation', 'termination', 'file-check']
