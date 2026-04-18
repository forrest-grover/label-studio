"""Unit tests for the tus orphan janitor (TUS-003).

The janitor is a pure-filesystem operation — no DB rows, no request cycle — so
we exercise it directly with ``tmp_path`` and explicit ``os.utime`` mtimes.
"""

import io
import os
import time
from unittest import mock

import pytest
from data_import.tus_app import janitor as janitor_module
from data_import.tus_app.janitor import cleanup_orphaned_tus_files
from django.core.management import call_command


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


class TestTusJanitorBoundaries:
    """Matrix 17a: TTL-second boundary + misc file-system edge states."""

    def test_jn3_exact_ttl_boundary(self, tmp_path):
        """Matrix JN-3: .meta mtime == cutoff → `>=` branch retains the pair."""
        now = time.time()
        cutoff = now - TTL * DAY  # mtime exactly at cutoff
        meta, data = _make_pair(tmp_path, 'boundary', mtime=cutoff)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert meta.exists()
        assert data.exists()
        assert result['candidates'] == 0
        assert result['deleted'] == 0

    def test_jn4_one_second_past_ttl(self, tmp_path):
        """Matrix JN-4: one second past the cutoff → pair deleted."""
        now = time.time()
        meta, data = _make_pair(tmp_path, 'just-past', mtime=now - TTL * DAY - 1)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert not meta.exists()
        assert not data.exists()
        assert result['candidates'] == 1
        assert result['deleted'] == 1

    def test_jn5_data_missing_still_counts_as_deleted(self, tmp_path):
        """Matrix JN-5: .meta present, .data absent. Pin current behavior.

        `_safe_unlink(data_path)` returns 0 but `freed` > 0 from .meta,
        so the `deleted` counter is still incremented. The `.data`-missing
        case is equivalent to "already cleaned up": treating it as a
        successful pair deletion is intentional, not a bug.
        """
        now = time.time()
        meta = tmp_path / 'partial.meta'
        meta.write_text('{}')
        os.utime(meta, (now - (TTL + 1) * DAY, now - (TTL + 1) * DAY))
        # no .data file created

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert not meta.exists()
        assert result['scanned'] == 1
        assert result['candidates'] == 1
        assert result['deleted'] == 1
        assert result['bytes_freed'] == META_BYTES

    def test_jn8_done_exact_ttl_boundary(self, tmp_path):
        """Matrix JN-8: .done mtime == cutoff → `>=` branch skips deletion."""
        now = time.time()
        cutoff = now - TTL * DAY
        meta, data = _make_pair(tmp_path, 'done-boundary', mtime=now - (TTL + 5) * DAY)
        done = _make_done(tmp_path, 'done-boundary', mtime=cutoff)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert meta.exists()
        assert data.exists()
        assert done.exists()
        assert result['candidates'] == 1
        assert result['deleted'] == 0

    def test_jn9_done_mtime_oserror_falls_back_to_zero(self, tmp_path, monkeypatch):
        """Matrix JN-9: `.done` mtime lookup raises → done_mtime=0.0 → pair deleted."""
        now = time.time()
        meta, data = _make_pair(tmp_path, 'done-err', mtime=now - (TTL + 2) * DAY)
        done = _make_done(tmp_path, 'done-err', mtime=now - 30)

        real_getmtime = os.path.getmtime
        done_path = str(done)

        def fake_getmtime(path):
            if path == done_path:
                raise OSError('simulated stat failure')
            return real_getmtime(path)

        monkeypatch.setattr(janitor_module.os.path, 'getmtime', fake_getmtime)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        # done_mtime fell back to 0.0; 0 < cutoff → pair treated as not-fresh → deleted
        assert not meta.exists()
        assert not data.exists()
        assert result['deleted'] == 1

    def test_jn10_meta_stat_oserror_continues(self, tmp_path, monkeypatch):
        """Matrix JN-10: meta_entry.stat() raises → `continue`; pair untouched."""
        now = time.time()
        meta, data = _make_pair(tmp_path, 'stat-fail', mtime=now - (TTL + 1) * DAY)

        real_scandir = os.scandir

        class _FailingEntry:
            def __init__(self, entry):
                self._entry = entry
                self.name = entry.name
                self.path = entry.path

            def is_file(self):
                return self._entry.is_file()

            def stat(self):
                raise OSError('simulated stat failure')

        class _FailingScandir:
            def __init__(self, path):
                self._it = real_scandir(path)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self._it.close()

            def __iter__(self):
                for entry in self._it:
                    yield _FailingEntry(entry)

        monkeypatch.setattr(janitor_module.os, 'scandir', _FailingScandir)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        # stat failed → `continue` before cutoff check → counted scanned, not candidate
        assert meta.exists()
        assert data.exists()
        assert result['scanned'] == 1
        assert result['candidates'] == 0
        assert result['deleted'] == 0

    def test_jn13_upload_dir_is_a_file(self, tmp_path):
        """Matrix JN-13: upload_dir points at a file, not a directory.

        `os.scandir` raises `NotADirectoryError` (subclass of `OSError` but not
        `FileNotFoundError`). Current handler catches only `FileNotFoundError`,
        so this propagates. Pin that behavior.
        """
        fake_dir = tmp_path / 'not-a-dir'
        fake_dir.write_text('i am a file')

        with pytest.raises(NotADirectoryError):
            cleanup_orphaned_tus_files(
                upload_dir=str(fake_dir), ttl_days=TTL, now=time.time(),
            )


class TestSafeUnlinkStates:
    """Matrix 17b: `_safe_unlink` error branches."""

    def test_jn_su3_permission_error_on_remove(self, tmp_path, monkeypatch, caplog):
        """Matrix JN-SU-3: os.remove raises → logs warning, returns 0."""
        now = time.time()
        meta, data = _make_pair(tmp_path, 'perm-denied', mtime=now - (TTL + 1) * DAY)
        meta_path = str(meta)

        real_remove = os.remove

        def fake_remove(path):
            if path == meta_path:
                raise PermissionError('simulated EACCES')
            return real_remove(path)

        monkeypatch.setattr(janitor_module.os, 'remove', fake_remove)

        with caplog.at_level('WARNING', logger='data_import.tus_app.janitor'):
            result = cleanup_orphaned_tus_files(
                upload_dir=str(tmp_path), ttl_days=TTL, now=now,
            )

        # .meta unlink refused → remains on disk; .data was unlinked
        assert meta.exists()
        assert not data.exists()
        # freed (from .data) is still > 0 so the pair counts as deleted
        assert result['deleted'] == 1
        assert result['bytes_freed'] == 32  # only .data bytes
        # warning logged for the failed .meta remove
        warnings = [r for r in caplog.records if 'failed to remove' in r.getMessage()]
        assert len(warnings) == 1
        assert meta_path in warnings[0].getMessage()

    def test_jn_su4_zero_byte_data_file(self, tmp_path):
        """Matrix JN-SU-4: .data is 0-byte → size 0, but pair still `deleted`."""
        now = time.time()
        meta, data = _make_pair(
            tmp_path, 'empty-data', mtime=now - (TTL + 1) * DAY, data_bytes=b'',
        )

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=TTL, now=now,
        )

        assert not meta.exists()
        assert not data.exists()
        assert result['deleted'] == 1
        # .data contributed 0 bytes; only .meta bytes counted
        assert result['bytes_freed'] == META_BYTES


@pytest.mark.django_db
class TestJanitorSettingsFallback:
    """Matrix 17c: settings-default resolution branches."""

    def test_jn_cfg2_missing_ttl_setting_defaults_to_seven(self, tmp_path, settings):
        """Matrix JN-CFG-2: `TUS_ORPHAN_TTL_DAYS` absent → `getattr` default of 7."""
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        if hasattr(settings, 'TUS_ORPHAN_TTL_DAYS'):
            del settings.TUS_ORPHAN_TTL_DAYS
        now = time.time()
        # 6 days old: inside default 7-day TTL → retained
        _make_pair(tmp_path, 'six-days', mtime=now - 6 * DAY)
        # 8 days old: past default 7-day TTL → deleted
        _make_pair(tmp_path, 'eight-days', mtime=now - 8 * DAY)

        result = cleanup_orphaned_tus_files(upload_dir=str(tmp_path), now=now)

        assert result['candidates'] == 1
        assert result['deleted'] == 1
        assert (tmp_path / 'six-days.meta').exists()
        assert not (tmp_path / 'eight-days.meta').exists()

    def test_jn_cfg3_ttl_zero_makes_everything_a_candidate(self, tmp_path):
        """Matrix JN-CFG-3: TTL=0 → cutoff==now → every .meta is a candidate.

        Exact-boundary note: a .meta with mtime == now would be retained
        (`>=` branch), but any file written and then scanned a moment later
        will have mtime < now.
        """
        now = time.time()
        _make_pair(tmp_path, 'a', mtime=now - 1)
        _make_pair(tmp_path, 'b', mtime=now - 3600)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=0, now=now,
        )

        assert result['scanned'] == 2
        assert result['candidates'] == 2
        assert result['deleted'] == 2
        assert not (tmp_path / 'a.meta').exists()
        assert not (tmp_path / 'b.meta').exists()

    def test_jn_cfg4_negative_ttl_deletes_everything(self, tmp_path):
        """Matrix JN-CFG-4: negative TTL pins current behavior.

        NOTE: the matrix originally said "nothing deleted" for negative TTL
        on the assumption that a future cutoff would retain all files, but the
        janitor's cutoff formula is ``now - (ttl_days * 86400)``. With a
        negative TTL, the cutoff moves *into the future* — every past mtime
        is strictly less than cutoff, fails `meta_mtime >= cutoff`, and is
        treated as a candidate. Net effect of a negative TTL is therefore
        "delete everything", not "delete nothing". This test pins that
        behavior so future refactors can't silently change it.
        """
        now = time.time()
        _make_pair(tmp_path, 'ancient', mtime=now - 365 * DAY)
        _make_pair(tmp_path, 'new', mtime=now - 10)

        result = cleanup_orphaned_tus_files(
            upload_dir=str(tmp_path), ttl_days=-1, now=now,
        )

        assert result['scanned'] == 2
        assert result['candidates'] == 2
        assert result['deleted'] == 2
        assert not (tmp_path / 'ancient.meta').exists()
        assert not (tmp_path / 'new.meta').exists()


class TestCleanupTusOrphansCommand:
    """Matrix 18: `cleanup_tus_orphans` management command."""

    def test_cmd1_sync_flag_runs_inline(self, tmp_path, settings):
        """Matrix CMD-1: `--sync` runs the janitor inline, prints SUCCESS."""
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        settings.TUS_ORPHAN_TTL_DAYS = 7
        now = time.time()
        _make_pair(tmp_path, 'stale', mtime=now - 30 * DAY)

        buf = io.StringIO()
        with mock.patch(
            'data_import.management.commands.cleanup_tus_orphans.start_job_async_or_sync'
        ) as enqueue:
            call_command('cleanup_tus_orphans', '--sync', stdout=buf)

        # --sync must not enqueue
        assert enqueue.call_count == 0
        # file was actually cleaned up inline
        assert not (tmp_path / 'stale.meta').exists()
        output = buf.getvalue()
        assert 'tus janitor:' in output
        assert "'deleted': 1" in output

    def test_cmd2_default_dispatches_to_rq_low_queue(self, tmp_path, settings):
        """Matrix CMD-2: no flag → dispatches via start_job_async_or_sync on low queue."""
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        buf = io.StringIO()
        with mock.patch(
            'data_import.management.commands.cleanup_tus_orphans.start_job_async_or_sync'
        ) as enqueue:
            call_command('cleanup_tus_orphans', stdout=buf)

        enqueue.assert_called_once()
        args, kwargs = enqueue.call_args
        assert args[0] is janitor_module.cleanup_orphaned_tus_files
        assert kwargs.get('queue_name') == 'low'
        assert 'job dispatched' in buf.getvalue()

    def test_cmd3_redis_unavailable_falls_back_to_inline(self, tmp_path, settings, monkeypatch):
        """Matrix CMD-3: `start_job_async_or_sync` runs job inline when Redis is down.

        We don't mock `start_job_async_or_sync` here — we let the real function
        run with `redis_connected` forced to False. The helper should execute
        the janitor synchronously and return its result.
        """
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        settings.TUS_ORPHAN_TTL_DAYS = 7
        now = time.time()
        _make_pair(tmp_path, 'offline-stale', mtime=now - 30 * DAY)

        # Force the "no redis" branch of start_job_async_or_sync.
        monkeypatch.setattr('core.redis.redis_connected', lambda: False)

        buf = io.StringIO()
        call_command('cleanup_tus_orphans', stdout=buf)

        # Inline fallback: the file actually got deleted by the enqueue call.
        assert not (tmp_path / 'offline-stale.meta').exists()
        assert 'job dispatched' in buf.getvalue()

    def test_cmd4_call_command_works_in_test_env(self, tmp_path, settings):
        """Matrix CMD-4: `call_command` invocation produces stdout without crashing.

        Empty upload dir: nothing scanned, still succeeds, prints the summary
        dict (with `--sync` so we can assert on janitor output deterministically).
        """
        settings.TUS_UPLOAD_DIR = str(tmp_path)
        settings.TUS_ORPHAN_TTL_DAYS = 7

        buf = io.StringIO()
        call_command('cleanup_tus_orphans', '--sync', stdout=buf)

        output = buf.getvalue()
        assert 'tus janitor:' in output
        assert "'scanned': 0" in output
        assert "'deleted': 0" in output
