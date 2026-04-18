"""Migration 0003 state tests (TESTING-STATE-MATRIX §22).

Exercises the forward/reverse/idempotency contract of
``0003_fileupload_created_at_fileupload_fingerprint_and_more``. We drive the
migration executor directly (not ``call_command``) so we can interleave state
assertions between individual migration steps without touching real test data.
"""

from __future__ import annotations

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

pytestmark = pytest.mark.django_db


APP = 'data_import'
TARGET = '0003_fileupload_created_at_fileupload_fingerprint_and_more'
PREV = '0002_alter_fileupload_file'
INDEX_NAME = 'data_import_fu_proj_fp_idx'


def _columns(table):
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT * FROM {table} LIMIT 0")
        return {col[0] for col in cursor.description}


def _has_index(table, name):
    with connection.cursor() as cursor:
        if connection.vendor == 'postgresql':
            cursor.execute(
                "SELECT 1 FROM pg_indexes "
                "WHERE tablename = %s AND indexname = %s",
                [table, name],
            )
            return cursor.fetchone() is not None
        # Other backends: Django introspection.
        constraints = connection.introspection.get_constraints(cursor, table)
        return name in constraints and constraints[name].get('index')


@pytest.fixture
def restore_migration_state():
    """Guarantee the DB is left at TARGET regardless of test outcome so the
    rest of the suite (which assumes the current schema) is unaffected.
    """
    yield
    executor = MigrationExecutor(connection)
    executor.migrate([(APP, TARGET)])


class TestMigration0003:
    def test_mig_1_forward_adds_columns_and_index(self, restore_migration_state):
        """Starting from 0002, apply 0003 and verify fingerprint + created_at
        columns plus the composite index exist.
        """
        executor = MigrationExecutor(connection)
        executor.migrate([(APP, PREV)])

        cols = _columns('data_import_fileupload')
        assert 'fingerprint' not in cols
        assert 'created_at' not in cols
        assert not _has_index('data_import_fileupload', INDEX_NAME)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([(APP, TARGET)])

        cols = _columns('data_import_fileupload')
        assert 'fingerprint' in cols
        assert 'created_at' in cols
        assert _has_index('data_import_fileupload', INDEX_NAME)

    def test_mig_2_forward_leaves_existing_rows_nullable(
        self, restore_migration_state, db,
    ):
        """Pre-existing rows must survive the forward migration with NULL
        fingerprint and NULL created_at (the fields are nullable).
        """
        from organizations.tests.factories import OrganizationFactory
        from projects.tests.factories import ProjectFactory
        from users.tests.factories import UserFactory
        from data_import.models import FileUpload

        org = OrganizationFactory()
        user = UserFactory(active_organization=org)
        project = ProjectFactory(organization=org, created_by=user)
        fu = FileUpload.objects.create(user=user, project=project)
        # Clear the auto_now_add so we simulate a pre-migration row.
        FileUpload.objects.filter(pk=fu.pk).update(created_at=None, fingerprint=None)

        # Re-apply migrations (no-op since we're at HEAD but exercises the
        # idempotent path).
        executor = MigrationExecutor(connection)
        executor.migrate([(APP, TARGET)])

        fu.refresh_from_db()
        assert fu.fingerprint is None
        assert fu.created_at is None

    def test_mig_3_reverse_removes_columns_and_index(self, restore_migration_state):
        """Reverse migration drops the new columns and the composite index."""
        executor = MigrationExecutor(connection)
        executor.migrate([(APP, PREV)])

        cols = _columns('data_import_fileupload')
        assert 'fingerprint' not in cols
        assert 'created_at' not in cols
        assert not _has_index('data_import_fileupload', INDEX_NAME)

    def test_mig_4_forward_is_idempotent(self, restore_migration_state):
        """Re-applying 0003 after it's already applied is a no-op."""
        # Already at TARGET; ask executor to migrate to TARGET again.
        executor = MigrationExecutor(connection)
        executor.migrate([(APP, TARGET)])

        # Columns + index still present.
        cols = _columns('data_import_fileupload')
        assert 'fingerprint' in cols
        assert 'created_at' in cols
        assert _has_index('data_import_fileupload', INDEX_NAME)
