"""Unit tests for server-side fingerprint dedup (TUS-005).

The tus finalize path is a signal receiver (``tus_app.receivers.on_tus_upload_finished``)
that runs ``create_file_upload`` against a temp file. We exercise it directly:
fire the signal twice with the same ``lsFingerprint`` metadata and assert only
one FileUpload row exists.

Isolating from the full tus view cycle keeps the test fast and deterministic
(no HTTP, no DRF parser, no multi-worker concerns) while still covering the
exact code path that reproduces the 192/191 bug in tier_resume.py.
"""

from __future__ import annotations

import os
from datetime import timedelta

import pytest
from django.utils import timezone

from data_import.models import FileUpload
from data_import.tus_app.receivers import _find_existing_fileupload, on_tus_upload_finished
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from users.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


def _write_temp_upload(tmp_path, name: str, payload: bytes) -> str:
    """Write a fake tus-assembled temp file and return its path. The finalize
    receiver opens this via ``open(path, 'rb')`` so any regular file works.
    """
    p = tmp_path / name
    p.write_bytes(payload)
    return str(p)


def _fire_finalize(*, tmp_path, project, user, fingerprint, filename, resource_id, payload=b'x'):
    upload_path = _write_temp_upload(tmp_path, f'{resource_id}.data', payload)
    metadata = {
        'filename': filename,
        'projectId': str(project.id),
    }
    if fingerprint is not None:
        metadata['lsFingerprint'] = fingerprint
    on_tus_upload_finished(
        sender=None,
        metadata=metadata,
        upload_file_path=upload_path,
        user=user,
        resource_id=resource_id,
        file_size=len(payload),
        filename=filename,
    )
    # Receiver always removes the temp file; assert so a regression leaves a
    # visible trail instead of silently hoarding bytes.
    assert not os.path.exists(upload_path)


@pytest.fixture
def project_user(db):
    org = OrganizationFactory()
    user = UserFactory(active_organization=org)
    project = ProjectFactory(organization=org, created_by=user)
    return project, user


@pytest.fixture(autouse=True)
def _tus_upload_dir(tmp_path, settings):
    """Keep tus .done markers out of the real MEDIA_ROOT during tests."""
    d = tmp_path / 'tus-tmp'
    d.mkdir()
    settings.TUS_UPLOAD_DIR = str(d)
    return d


class TestTusFingerprintDedup:
    def test_same_fingerprint_reuses_row(self, tmp_path, project_user):
        project, user = project_user
        fp = 'file.png:1024:1700000000000'

        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='file.png', resource_id='r1',
        )
        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='file.png', resource_id='r2',
        )

        rows = FileUpload.objects.filter(project=project)
        assert rows.count() == 1, 'second finalize with same fingerprint must dedup'
        assert rows.first().fingerprint == fp

    def test_done_marker_written_on_dedup_hit(self, tmp_path, project_user, settings):
        """Client handshake: both finalize paths must produce a .done marker
        pointing at the FileUpload id, or the UI stalls waiting for id lookup.
        """
        project, user = project_user
        fp = 'dup.bin:500:1700000001000'

        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='dup.bin', resource_id='orig',
        )
        row = FileUpload.objects.get(project=project)

        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='dup.bin', resource_id='dupe',
        )

        dupe_marker = os.path.join(settings.TUS_UPLOAD_DIR, 'dupe.done')
        assert os.path.exists(dupe_marker)
        with open(dupe_marker) as f:
            assert f.read().strip() == str(row.id)

    def test_different_fingerprints_create_separate_rows(self, tmp_path, project_user):
        project, user = project_user
        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint='a.bin:1:1', filename='a.bin', resource_id='ra',
        )
        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint='b.bin:2:2', filename='b.bin', resource_id='rb',
        )
        assert FileUpload.objects.filter(project=project).count() == 2

    def test_different_projects_do_not_dedup(self, tmp_path, project_user):
        """Dedup is scoped by project — same fingerprint in a different project
        is still a distinct upload.
        """
        project_a, user = project_user
        project_b = ProjectFactory(organization=project_a.organization, created_by=user)
        fp = 'shared.bin:10:10'

        _fire_finalize(
            tmp_path=tmp_path, project=project_a, user=user,
            fingerprint=fp, filename='shared.bin', resource_id='pa',
        )
        _fire_finalize(
            tmp_path=tmp_path, project=project_b, user=user,
            fingerprint=fp, filename='shared.bin', resource_id='pb',
        )

        assert FileUpload.objects.filter(project=project_a).count() == 1
        assert FileUpload.objects.filter(project=project_b).count() == 1

    def test_missing_fingerprint_skips_dedup(self, tmp_path, project_user):
        """Old clients that don't send ``lsFingerprint`` must still work —
        every finalize produces a new row (no dedup benefit, no breakage).
        """
        project, user = project_user
        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=None, filename='legacy.bin', resource_id='l1',
        )
        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=None, filename='legacy.bin', resource_id='l2',
        )
        assert FileUpload.objects.filter(project=project).count() == 2

    def test_outside_ttl_window_does_not_dedup(self, tmp_path, project_user, settings):
        """Rows older than ``TUS_SERVER_DEDUP_WINDOW_HOURS`` are not reused —
        a week-old upload with a colliding fingerprint should re-upload.
        """
        project, user = project_user
        settings.TUS_SERVER_DEDUP_WINDOW_HOURS = 1
        fp = 'stale.bin:7:7'

        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='stale.bin', resource_id='old',
        )
        # Backdate the row past the 1-hour window.
        FileUpload.objects.filter(project=project).update(
            created_at=timezone.now() - timedelta(hours=2),
        )

        _fire_finalize(
            tmp_path=tmp_path, project=project, user=user,
            fingerprint=fp, filename='stale.bin', resource_id='new',
        )
        assert FileUpload.objects.filter(project=project).count() == 2


class TestFindExistingHelper:
    """Direct tests for the dedup query helper. Kept separate from the signal-
    path tests so a helper-level regression surfaces with a narrower signature.
    """

    def test_returns_none_for_missing_fingerprint(self, project_user):
        project, _ = project_user
        assert _find_existing_fileupload(project.id, '') is None
        assert _find_existing_fileupload(project.id, None) is None

    def test_returns_most_recent_match(self, project_user, settings):
        project, user = project_user
        settings.TUS_SERVER_DEDUP_WINDOW_HOURS = 24
        fp = 'pick-me:1:1'
        older = FileUpload.objects.create(user=user, project=project, fingerprint=fp)
        newer = FileUpload.objects.create(user=user, project=project, fingerprint=fp)
        # auto_now_add sets both to ~now; nudge `older` back so ordering is deterministic.
        FileUpload.objects.filter(pk=older.pk).update(
            created_at=timezone.now() - timedelta(minutes=10),
        )
        hit = _find_existing_fileupload(project.id, fp)
        assert hit is not None
        assert hit.pk == newer.pk
