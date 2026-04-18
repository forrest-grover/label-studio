"""Error-path tests for the tus finalize receiver (TESTING-STATE-MATRIX §19b, §20).

Isolates each failure mode in ``on_tus_upload_finished`` / ``_find_existing_fileupload``
so a regression surfaces with a state-id-prefixed failure instead of a generic
signal-level stacktrace. All tests exercise the receiver as a plain callable —
no HTTP, no DRF — for the same determinism reasons as test_tus_dedup.py.
"""

from __future__ import annotations

import os
from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone

from data_import.models import FileUpload
from data_import.tus_app import receivers
from data_import.tus_app.receivers import (
    _find_existing_fileupload,
    on_tus_upload_finished,
)
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from users.tests.factories import UserFactory

pytestmark = pytest.mark.django_db


def _write_temp(tmp_path, resource_id, payload=b'x'):
    p = tmp_path / f'{resource_id}.data'
    p.write_bytes(payload)
    return str(p)


def _fire(**kwargs):
    kwargs.setdefault('sender', None)
    kwargs.setdefault('file_size', 1)
    return on_tus_upload_finished(**kwargs)


@pytest.fixture
def project_user(db):
    org = OrganizationFactory()
    user = UserFactory(active_organization=org)
    project = ProjectFactory(organization=org, created_by=user)
    return project, user


@pytest.fixture(autouse=True)
def _tus_upload_dir(tmp_path, settings):
    d = tmp_path / 'tus-tmp'
    d.mkdir()
    settings.TUS_UPLOAD_DIR = str(d)
    return d


# --- §19b error paths -------------------------------------------------------


class TestReceiverErrorPaths:
    def test_rx_err_1_missing_project_id(self, tmp_path, project_user, caplog):
        _, user = project_user
        upload = _write_temp(tmp_path, 'noproj')

        with caplog.at_level('ERROR'):
            _fire(
                metadata={'filename': 'f.bin'},  # no projectId
                upload_file_path=upload,
                user=user,
                resource_id='noproj',
                filename='f.bin',
            )

        # Temp file cleaned, no row created, error logged, receiver returned.
        assert not os.path.exists(upload)
        assert FileUpload.objects.count() == 0
        assert any('missing projectId' in r.getMessage() for r in caplog.records)

    def test_rx_err_2_project_does_not_exist(self, tmp_path, project_user, caplog):
        _, user = project_user
        upload = _write_temp(tmp_path, 'ghost')

        with caplog.at_level('ERROR'):
            _fire(
                metadata={'filename': 'f.bin', 'projectId': '999999'},
                upload_file_path=upload,
                user=user,
                resource_id='ghost',
                filename='f.bin',
            )

        assert not os.path.exists(upload)
        assert FileUpload.objects.count() == 0
        assert any('not found' in r.getMessage() for r in caplog.records)

    def test_rx_err_3_non_int_project_id(self, tmp_path, project_user, caplog):
        """Bug fix: a non-int projectId used to raise ValueError at int() and
        escape as an unhandled exception. Should now log + clean up + return.
        """
        _, user = project_user
        upload = _write_temp(tmp_path, 'badpk')

        with caplog.at_level('ERROR'):
            # Should not raise.
            _fire(
                metadata={'filename': 'f.bin', 'projectId': 'abc'},
                upload_file_path=upload,
                user=user,
                resource_id='badpk',
                filename='f.bin',
            )

        assert not os.path.exists(upload)
        assert FileUpload.objects.count() == 0
        assert any('invalid projectId' in r.getMessage() for r in caplog.records)

    def test_rx_err_4_create_file_upload_raises(self, tmp_path, project_user):
        """If create_file_upload blows up we must clean the temp file and
        re-raise so the tus signal sender returns 5xx to the client.
        """
        project, user = project_user
        upload = _write_temp(tmp_path, 'boom')

        with mock.patch(
            'data_import.tus_app.receivers.create_file_upload',
            side_effect=RuntimeError('disk exploded'),
        ):
            with pytest.raises(RuntimeError, match='disk exploded'):
                _fire(
                    metadata={'filename': 'f.bin', 'projectId': str(project.id)},
                    upload_file_path=upload,
                    user=user,
                    resource_id='boom',
                    filename='f.bin',
                )

        assert not os.path.exists(upload), 'temp file must be cleaned on error'
        assert FileUpload.objects.count() == 0

    def test_rx_err_5_done_marker_write_failure_propagates(self, tmp_path, project_user):
        """Bug fix: a failing .done write used to return normally, stalling the
        client forever. Should now raise so the tus error response bubbles up.
        """
        project, user = project_user
        upload = _write_temp(tmp_path, 'nodone')

        with mock.patch(
            'data_import.tus_app.receivers.open',
            side_effect=OSError('read-only fs'),
            create=True,
        ) as mocked_open:
            # First open (opening the temp file) must work; only the .done
            # write should fail. We distinguish by path suffix.
            real_open = open

            def selective_open(path, *a, **kw):
                if str(path).endswith('.done'):
                    raise OSError('read-only fs')
                return real_open(path, *a, **kw)

            mocked_open.side_effect = selective_open

            with pytest.raises(OSError, match='read-only fs'):
                _fire(
                    metadata={
                        'filename': 'f.bin',
                        'projectId': str(project.id),
                        'lsFingerprint': 'f.bin:1:1',
                    },
                    upload_file_path=upload,
                    user=user,
                    resource_id='nodone',
                    filename='f.bin',
                )

    def test_rx_err_6_upload_file_path_is_none(self, tmp_path, project_user):
        """A None upload_file_path should not crash on temp cleanup, but it
        will raise TypeError on open() inside create_file_upload — re-raised
        through the generic exception handler.
        """
        project, user = project_user

        with pytest.raises(TypeError):
            _fire(
                metadata={'filename': 'f.bin', 'projectId': str(project.id)},
                upload_file_path=None,
                user=user,
                resource_id='nopath',
                filename='f.bin',
            )

        # _safe_remove(None) is a no-op so nothing to assert on the fs side.
        assert FileUpload.objects.count() == 0

    def test_rx_err_7_temp_file_disappears_between_finalize_and_open(
        self, tmp_path, project_user,
    ):
        """Simulate the race where another process removes the temp file
        between the dedup-miss and open() — we should propagate FileNotFound.
        """
        project, user = project_user
        upload = _write_temp(tmp_path, 'race')
        os.remove(upload)  # gone before receiver opens it

        with pytest.raises(FileNotFoundError):
            _fire(
                metadata={'filename': 'f.bin', 'projectId': str(project.id)},
                upload_file_path=upload,
                user=user,
                resource_id='race',
                filename='f.bin',
            )

        assert FileUpload.objects.count() == 0


# --- §19c fingerprint stamping post-save ------------------------------------


class TestFingerprintStamping:
    def test_rx_st_2_fingerprint_already_set_skips_second_save(
        self, tmp_path, project_user,
    ):
        """If create_file_upload already stamped the fingerprint (unlikely but
        possible), the receiver must not issue a second save(update_fields).
        Guarded by `file_upload.fingerprint != fingerprint`.
        """
        project, user = project_user
        upload = _write_temp(tmp_path, 'st2')
        fp = 'same.bin:1:1'

        original_create = receivers.create_file_upload

        def create_and_stamp(user_, project_, file_):
            fu = original_create(user_, project_, file_)
            fu.fingerprint = fp
            fu.save(update_fields=['fingerprint'])
            return fu

        with mock.patch(
            'data_import.tus_app.receivers.create_file_upload',
            side_effect=create_and_stamp,
        ):
            with mock.patch.object(
                FileUpload, 'save', wraps=FileUpload.save, autospec=True,
            ) as save_spy:
                _fire(
                    metadata={
                        'filename': 'same.bin',
                        'projectId': str(project.id),
                        'lsFingerprint': fp,
                    },
                    upload_file_path=upload,
                    user=user,
                    resource_id='st2',
                    filename='same.bin',
                )

        # One save inside create (initial insert), one save inside
        # create_and_stamp (update_fields=['fingerprint']) — but crucially the
        # receiver itself should NOT call save a third time because the
        # fingerprint already matches.
        update_field_saves = [
            c for c in save_spy.call_args_list
            if c.kwargs.get('update_fields') == ['fingerprint']
        ]
        assert len(update_field_saves) == 1, (
            'receiver must skip the second fingerprint save when the value '
            'already matches'
        )
        # And the row has the fingerprint.
        assert FileUpload.objects.get(project=project).fingerprint == fp


# --- §20 _find_existing_fileupload ------------------------------------------


class TestFindExistingHelperGaps:
    def test_rx_fe_4_no_rows_at_all(self, project_user):
        """Helper-level: empty DB, any non-empty fingerprint returns None."""
        project, _ = project_user
        assert _find_existing_fileupload(project.id, 'nothing:0:0') is None

    def test_rx_fe_5_setting_missing_defaults_to_24(self, project_user, settings):
        """getattr default kicks in when TUS_SERVER_DEDUP_WINDOW_HOURS is unset."""
        project, user = project_user
        fp = 'default.bin:1:1'
        FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        # Remove the setting entirely and verify a 1-hour-old row still matches
        # (24h default window).
        del settings.TUS_SERVER_DEDUP_WINDOW_HOURS
        hit = _find_existing_fileupload(project.id, fp)
        assert hit is not None

    def test_rx_fe_6_window_zero_disables_dedup(self, project_user, settings):
        """Pin current behavior: window=0 means `cutoff=now`, and rows created
        even a millisecond earlier are excluded by `created_at__gte=cutoff`.
        Documented as a feature flag: set to 0 to disable server-side dedup.
        """
        project, user = project_user
        settings.TUS_SERVER_DEDUP_WINDOW_HOURS = 0
        fp = 'window0.bin:1:1'
        FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        # Row exists but window is zero — helper should not find it.
        assert _find_existing_fileupload(project.id, fp) is None

    def test_rx_fe_7_non_int_window_falls_back_to_default(
        self, project_user, settings, caplog,
    ):
        """Bug fix: a malformed setting value used to raise ValueError at
        int(); now we warn and fall back to 24h.
        """
        project, user = project_user
        settings.TUS_SERVER_DEDUP_WINDOW_HOURS = 'garbage'
        fp = 'nonint.bin:1:1'
        FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        with caplog.at_level('WARNING'):
            hit = _find_existing_fileupload(project.id, fp)

        assert hit is not None, 'fallback to 24h means the fresh row still matches'
        assert any('not an int' in r.getMessage() for r in caplog.records)

    def test_rx_fe_9_exact_window_boundary_is_included(self, project_user, settings):
        """`created_at__gte=cutoff` is inclusive, so a row whose created_at
        equals the cutoff to the microsecond is a match, not a miss.
        """
        project, user = project_user
        settings.TUS_SERVER_DEDUP_WINDOW_HOURS = 1
        fp = 'boundary.bin:1:1'
        fu = FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        # Pin the row exactly on the cutoff boundary, then freeze "now" so
        # the helper recomputes the same cutoff.
        frozen = timezone.now()
        cutoff = frozen - timedelta(hours=1)
        FileUpload.objects.filter(pk=fu.pk).update(created_at=cutoff)

        with mock.patch('data_import.tus_app.receivers.timezone.now', return_value=frozen):
            hit = _find_existing_fileupload(project.id, fp)

        assert hit is not None and hit.pk == fu.pk
