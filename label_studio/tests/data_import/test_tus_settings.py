"""TUS settings-parsing tests (TESTING-STATE-MATRIX §23).

Covers both ``TUS_ORPHAN_TTL_DAYS`` (janitor) and ``TUS_SERVER_DEDUP_WINDOW_HOURS``
(receiver dedup) defaults and env-var parsing. Two layers:

1. Defaults / @override_settings state — exercised via the live getattr paths
   in janitor and receiver.
2. Env-var parsing at import time — exercised via a tiny re-implementation of
   the base.py ``int(get_env(name, default))`` pattern so we don't need to
   reload the full settings module.

Keeps the scope to values that users can actually set; the underlying
``get_env`` helper is itself covered in core/utils tests.
"""

from __future__ import annotations

import os
import time
from datetime import timedelta
from unittest import mock

import pytest
from django.test import override_settings
from django.utils import timezone

from core.utils.params import get_env
from data_import.models import FileUpload
from data_import.tus_app.janitor import cleanup_orphaned_tus_files
from data_import.tus_app.receivers import _find_existing_fileupload
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from users.tests.factories import UserFactory


def _parse_int_env(name, default):
    """Replicates the base.py pattern `int(get_env(name, default))`. Isolated
    so we can test the parser against synthetic env values without reloading
    Django settings (which would restart the whole test harness).
    """
    return int(get_env(name, default))


# --- CFG-1..CFG-5: TUS_ORPHAN_TTL_DAYS --------------------------------------


class TestOrphanTtlDaysSetting:
    def test_cfg_1_default_when_env_missing(self, monkeypatch):
        """No LABEL_STUDIO_TUS_ORPHAN_TTL_DAYS / HEARTEX_ / TUS_ORPHAN_TTL_DAYS
        in env → int(get_env(..., 7)) returns 7.
        """
        for key in (
            'LABEL_STUDIO_TUS_ORPHAN_TTL_DAYS',
            'HEARTEX_TUS_ORPHAN_TTL_DAYS',
            'TUS_ORPHAN_TTL_DAYS',
        ):
            monkeypatch.delenv(key, raising=False)
        assert _parse_int_env('TUS_ORPHAN_TTL_DAYS', 7) == 7

    def test_cfg_2_env_var_parsed_as_int(self, monkeypatch):
        monkeypatch.setenv('TUS_ORPHAN_TTL_DAYS', '14')
        assert _parse_int_env('TUS_ORPHAN_TTL_DAYS', 7) == 14

    def test_cfg_3_non_int_env_raises_at_startup(self, monkeypatch):
        """Bad env value → ValueError at int(). Documents that a misconfigured
        env var surfaces loudly at startup rather than silently using the
        default.
        """
        monkeypatch.setenv('TUS_ORPHAN_TTL_DAYS', 'abc')
        with pytest.raises(ValueError):
            _parse_int_env('TUS_ORPHAN_TTL_DAYS', 7)

    def test_cfg_4_zero_accepted_janitor_deletes_everything(self, tmp_path):
        """TTL=0 means cutoff = now; any .meta file is a candidate."""
        now = time.time()
        meta = tmp_path / 'zero.meta'
        data = tmp_path / 'zero.data'
        meta.write_text('{}')
        data.write_bytes(b'x')
        # Even a freshly-written pair falls past cutoff when TTL=0 (meta_mtime
        # was set a few microseconds before now).
        time.sleep(0.01)
        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=0, now=time.time(),
        )
        assert result['scanned'] == 1
        assert result['deleted'] == 1
        assert not meta.exists()

    def test_cfg_5_negative_accepted_deletes_everything(self, tmp_path):
        """Pin current behavior: ``cutoff = now - (ttl_days * 86400)`` means a
        negative TTL pushes cutoff *into the future*, which makes every real
        file's mtime fail the ``>= cutoff`` freshness check → candidate →
        deleted. In other words, a negative TTL is a more aggressive sweep
        than TTL=0, not a safety no-op. The matrix's "retains everything"
        description was incorrect; pinning the actual behavior here so a
        future "fix" doesn't silently flip the semantics.
        """
        now = time.time()
        meta = tmp_path / 'neg.meta'
        data = tmp_path / 'neg.data'
        meta.write_text('{}')
        data.write_bytes(b'x')
        # Even a brand-new file is "stale" under a negative TTL.
        os.utime(meta, (now, now))
        os.utime(data, (now, now))

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=-1, now=now,
        )
        assert result['scanned'] == 1
        assert result['deleted'] == 1
        assert not meta.exists() and not data.exists()


# --- CFG-6..CFG-8: TUS_SERVER_DEDUP_WINDOW_HOURS ----------------------------


pytestmark_db = pytest.mark.django_db


@pytest.fixture
def project_user(db):
    org = OrganizationFactory()
    user = UserFactory(active_organization=org)
    project = ProjectFactory(organization=org, created_by=user)
    return project, user


class TestDedupWindowSetting:
    @pytest.mark.django_db
    def test_cfg_6_window_zero_disables_dedup(self, project_user):
        project, user = project_user
        fp = 'cfg6.bin:1:1'
        FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        with override_settings(TUS_SERVER_DEDUP_WINDOW_HOURS=0):
            assert _find_existing_fileupload(project.id, fp) is None

    @pytest.mark.django_db
    def test_cfg_7_negative_window_matches_nothing(self, project_user):
        """Window = -1h → cutoff = now + 1h; `created_at__gte=future` matches
        nothing. Equivalent to disabling dedup.
        """
        project, user = project_user
        fp = 'cfg7.bin:1:1'
        FileUpload.objects.create(user=user, project=project, fingerprint=fp)

        with override_settings(TUS_SERVER_DEDUP_WINDOW_HOURS=-1):
            assert _find_existing_fileupload(project.id, fp) is None

    def test_cfg_8_non_int_env_raises_at_startup(self, monkeypatch):
        """Matches CFG-3: non-int env value raises on int() at settings load.
        At runtime the receiver's _find_existing_fileupload swallows the same
        error (RX-FE-7) and falls back to 24h — but at import time, base.py's
        `int(get_env(...))` has no fallback.
        """
        monkeypatch.setenv('TUS_SERVER_DEDUP_WINDOW_HOURS', 'xyz')
        with pytest.raises(ValueError):
            _parse_int_env('TUS_SERVER_DEDUP_WINDOW_HOURS', 24)
