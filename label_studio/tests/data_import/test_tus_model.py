"""FileUpload model-level tests for TUS-005 fields (TESTING-STATE-MATRIX §21).

Separate from the receiver tests so a schema-layer regression (missing
nullable, index dropped, fingerprint width mismatch) surfaces with a model-
focused signature instead of masking inside a signal trace.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone

from data_import.models import FileUpload
from data_import.tus_app.receivers import (
    _find_existing_fileupload,
    _normalize_fingerprint,
)
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from users.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def project_user(db):
    org = OrganizationFactory()
    user = UserFactory(active_organization=org)
    project = ProjectFactory(organization=org, created_by=user)
    return project, user


class TestFileUploadFields:
    def test_mdl_2_legacy_row_without_fingerprint(self, project_user):
        """Legacy import path doesn't touch fingerprint — nullable must hold."""
        project, user = project_user
        fu = FileUpload.objects.create(user=user, project=project)
        assert fu.fingerprint is None
        assert fu.created_at is not None  # auto_now_add

    def test_mdl_3_null_created_at_excluded_from_dedup_query(self, project_user):
        """Rows with NULL `created_at` (e.g. pre-migration legacy) must NOT
        match the `created_at__gte=cutoff` dedup predicate. Django ORM excludes
        NULLs on `__gte` comparisons by default — pin that behavior so a future
        ORM change doesn't silently alter semantics.
        """
        project, user = project_user
        fp = 'mdl3.bin:1:1'
        fu = FileUpload.objects.create(user=user, project=project, fingerprint=fp)
        # Force created_at to NULL (simulating a pre-migration row).
        FileUpload.objects.filter(pk=fu.pk).update(created_at=None)

        assert _find_existing_fileupload(project.id, fp) is None, (
            'NULL created_at must be excluded from the dedup window query'
        )

    def test_mdl_4_max_length_fingerprint(self, project_user):
        """A 512-char fingerprint stores and round-trips verbatim."""
        project, user = project_user
        fp = 'a' * 512
        fu = FileUpload.objects.create(user=user, project=project, fingerprint=fp)
        fu.refresh_from_db()
        assert fu.fingerprint == fp
        assert len(fu.fingerprint) == 512

    def test_mdl_5_over_length_fingerprint_is_hashed(self, project_user):
        """Bug fix: oversized blobs (say, a 1024-char pathological filename)
        previously hit the DB layer as DataError. Now normalized to sha256
        before storage/query — identical inputs still match.
        """
        project, user = project_user
        raw = 'x' * 1024  # well over 512
        expected = hashlib.sha256(raw.encode('utf-8')).hexdigest()

        # Writer normalizes.
        normalized = _normalize_fingerprint(raw)
        assert normalized == expected
        assert len(normalized) == 64

        # Store it under the normalized value.
        FileUpload.objects.create(user=user, project=project, fingerprint=normalized)

        # Reader normalizes again — dedup still hits.
        hit = _find_existing_fileupload(project.id, raw)
        assert hit is not None
        assert hit.fingerprint == expected

    def test_mdl_6_composite_index_exists(self):
        """Introspect the `(project, fingerprint)` composite index added in
        migration 0003. Named index so we can query pg_indexes directly on
        Postgres; fall back to Django introspection on other backends.
        """
        expected_name = 'data_import_fu_proj_fp_idx'

        with connection.cursor() as cursor:
            if connection.vendor == 'postgresql':
                cursor.execute(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE tablename = 'data_import_fileupload'"
                )
                names = {row[0] for row in cursor.fetchall()}
                assert expected_name in names, (
                    f'expected composite index {expected_name!r} on '
                    f'data_import_fileupload; found {sorted(names)}'
                )
            else:
                # SQLite / other: use Django introspection.
                constraints = connection.introspection.get_constraints(
                    cursor, 'data_import_fileupload',
                )
                index_names = {
                    name for name, meta in constraints.items() if meta.get('index')
                }
                assert expected_name in index_names, (
                    f'expected composite index {expected_name!r}; '
                    f'found {sorted(index_names)}'
                )
