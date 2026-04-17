"""URL routing for the tus upload endpoints.

Routes (all additive; no overlap with existing ``/api/projects/...``):
  POST    /tus/projects/<project_id>/      — tus creation
  HEAD    /tus/resumable/<resource_id>     — tus offset query
  PATCH   /tus/resumable/<resource_id>     — tus chunk upload
  DELETE  /tus/resumable/<resource_id>     — tus termination
  GET     /tus/resumable/<resource_id>/file-upload-id  — LS: fetch the resulting FileUpload row id
"""

from django.urls import path

from .views import TusProjectCreateView, TusResourceView
from .views_extra import TusResourceResultView

app_name = 'tus_app'

urlpatterns = [
    path(
        'tus/projects/<int:project_id>/',
        TusProjectCreateView.as_view(),
        name='tus-project-create',
    ),
    path(
        'tus/resumable/<uuid:resource_id>',
        TusResourceView.as_view(),
        name='tus-resource',
    ),
    path(
        'tus/resumable/<uuid:resource_id>/file-upload-id',
        TusResourceResultView.as_view(),
        name='tus-resource-result',
    ),
]
