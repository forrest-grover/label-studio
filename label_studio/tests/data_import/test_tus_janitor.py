"""Unit tests for the tus orphan janitor (TUS-003).

The janitor is a pure-filesystem operation — no DB rows, no request cycle — so
we exercise it directly with ``tmp_path`` and explicit ``os.utime`` mtimes.
"""

import os
import time

import pytest
from data_import.tus_app.janitor import cleanup_orphaned_tus_files


DAY = 86400
TTL = 7  # days


META_BYTES = len('{}')  # _make_pair writes exactly these bytes into .meta


def _make_pair(tmp_path, resource_id: str, mtime: float, data_bytes: bytes = b'x' * 32):
    """Create <resource_id>.meta and <resource_id>.data with the given mtime."""
    meta = tmp_path / f'{resource_id}.meta'
    data = tmp_path / f'{resource_id}.data'
    meta.write_text('{}')
    data.write_bytes(data_bytes)
    os.utime(meta, (mtime, mtime))
    os.utime(data, (mtime, mtime))
    return meta, data


def _make_done(tmp_path, resource_id: str, mtime: float):
    done = tmp_path / f'{resource_id}.done'
    done.write_text('123')
    os.utime(done, (mtime, mtime))
    return done


class TestTusJanitor:
    def test_deletes_stale_pair(self, tmp_path):
        now = time.time()
        meta, data = _make_pair(tmp_path, 'abandoned', mtime=now - (TTL + 1) * DAY)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert not meta.exists()
        assert not data.exists()
        assert result['scanned'] == 1
        assert result['candidates'] == 1
        assert result['deleted'] == 1
        assert result['bytes_freed'] == 32 + META_BYTES

    def test_retains_fresh_pair(self, tmp_path):
        now = time.time()
        meta, data = _make_pair(tmp_path, 'inflight', mtime=now - 60)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert meta.exists()
        assert data.exists()
        assert result['scanned'] == 1
        assert result['candidates'] == 0
        assert result['deleted'] == 0
        assert result['bytes_freed'] == 0

    def test_retains_pair_with_fresh_done_peer(self, tmp_path):
        """.meta/.data are old but a .done peer is fresh (recently-finalized
        but the post-signal clean() race window hasn't closed). Skip deletion.
        """
        now = time.time()
        meta, data = _make_pair(tmp_path, 'just-finalized', mtime=now - (TTL + 2) * DAY)
        done = _make_done(tmp_path, 'just-finalized', mtime=now - 60)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert meta.exists()
        assert data.exists()
        assert done.exists()
        assert result['candidates'] == 1
        assert result['deleted'] == 0

    def test_deletes_pair_with_stale_done_peer(self, tmp_path):
        """.done peer older than TTL means the receiver's finalize step crashed
        long ago. Clean up the .meta/.data pair; leave .done alone (the extra
        view deletes it on read).
        """
        now = time.time()
        meta, data = _make_pair(tmp_path, 'ancient', mtime=now - (TTL + 3) * DAY)
        done = _make_done(tmp_path, 'ancient', mtime=now - (TTL + 3) * DAY)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert not meta.exists()
        assert not data.exists()
        assert done.exists()  # tombstone retained
        assert result['deleted'] == 1

    def test_mixed_directory(self, tmp_path):
        now = time.time()
        _make_pair(tmp_path, 'old1', mtime=now - (TTL + 1) * DAY)
        _make_pair(tmp_path, 'old2', mtime=now - (TTL + 5) * DAY, data_bytes=b'y' * 100)
        _make_pair(tmp_path, 'fresh', mtime=now - 60)
        _make_pair(tmp_path, 'recent-done', mtime=now - (TTL + 1) * DAY)
        _make_done(tmp_path, 'recent-done', mtime=now - 30)
        # stray .done with no pair — ignored entirely (not scanned)
        _make_done(tmp_path, 'lonely', mtime=now - 10)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert result['scanned'] == 4  # only .meta files counted
        assert result['candidates'] == 3  # 3 are past TTL
        assert result['deleted'] == 2  # recent-done skipped
        # 2 stale pairs deleted: old1 (32 data + meta) + old2 (100 data + meta)
        assert result['bytes_freed'] == 32 + 100 + 2 * META_BYTES
        assert not (tmp_path / 'old1.meta').exists()
        assert not (tmp_path / 'old2.data').exists()
        assert (tmp_path / 'fresh.meta').exists()
        assert (tmp_path / 'recent-done.meta').exists()
        assert (tmp_path / 'lonely.done').exists()

    def test_missing_upload_dir_is_noop(self, tmp_path):
        missing = tmp_path / 'does-not-exist'
        result = cleanup_orphaned_tus_files(
            upload_dir=str(missing), ttl_days=TTL, now=time.time(),
        )
        assert result == {'scanned': 0, 'candidates': 0, 'deleted': 0, 'bytes_freed': 0}

    def test_logs_summary_at_info(self, tmp_path, caplog):
        now = time.time()
        _make_pair(tmp_path, 'old', mtime=now - (TTL + 1) * DAY)

        with caplog.at_level('INFO', logger='data_import.tus_app.janitor'):
            cleanup_orphaned_tus_files(
                upload_dir=str(tmp_path), ttl_days=TTL, now=now,
            )

        summary = [r for r in caplog.records if 'tus janitor: scanned=' in r.getMessage()]
        assert len(summary) == 1
        msg = summary[0].getMessage()
        assert 'scanned=1' in msg and 'deleted=1' in msg and 'bytes_freed=' in msg


@pytest.mark.django_db
class TestTusJanitorDefaults:
    """Smoke test: the function resolves defaults from Django settings."""

    def test_reads_settings_when_args_omitted(self, tmp_path, settings, monkeypatch):
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        settings.TUS_ORPHAN_TTL_DAYS = 7
        now = time.time()
        _make_pair(tmp_path, 'stale', mtime=now - 30 * DAY)

        result = cleanup_orphaned_tus_files()

        assert result['deleted'] == 1
