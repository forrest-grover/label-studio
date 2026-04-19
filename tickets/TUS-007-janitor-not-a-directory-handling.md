---
id: TUS-007
title: Janitor crashes when TUS_UPLOAD_DIR points at a file instead of a directory
status: open
priority: P3
area: backend
created: 2026-04-19
related_branch: tus-upload
related_commits: "e1bf46aa4"
---

## Problem

`cleanup_orphaned_tus_files()` in `label_studio/data_import/tus_app/janitor.py` catches `FileNotFoundError` when `os.scandir(upload_dir)` fails (treated as a no-op — "upload dir has not been created yet"). It does NOT catch `NotADirectoryError`, which is raised when `upload_dir` resolves to an existing path that is a regular file rather than a directory.

If `TUS_UPLOAD_DIR` is misconfigured — e.g. pointed at an existing config file, or a symlink whose target was replaced with a file — the scheduled janitor job crashes with an uncaught `NotADirectoryError`. In production this means a recurring RQ job failure every run until the operator notices and fixes the setting.

Pinned as test `test_jn13_upload_dir_is_a_file_propagates` in `label_studio/tests/data_import/test_tus_janitor.py` (added in commit `e1bf46aa4`): the test documents the propagation behavior, but does not assert the desired behavior.

## Proposed fix

Widen the existing `FileNotFoundError` handler to also catch `NotADirectoryError`, treating a misconfigured path the same as a missing one (log a warning + return all-zero result). One-line change:

```python
except (FileNotFoundError, NotADirectoryError):
    logger.warning("tus janitor: TUS_UPLOAD_DIR %r is missing or not a directory; skipping run", upload_dir)
    return {"scanned": 0, "candidates": 0, "deleted": 0, "bytes_freed": 0}
```

Update `test_jn13_upload_dir_is_a_file_propagates` to assert the new no-op behavior and rename to `test_jn13_upload_dir_is_a_file_is_noop`.

## Acceptance criteria

- [ ] `cleanup_orphaned_tus_files()` returns zero-counts instead of raising when `TUS_UPLOAD_DIR` is a regular file
- [ ] Warning logged with the offending path so an operator can triage quickly
- [ ] Existing `FileNotFoundError` handling preserved (same message style)
- [ ] JN-13 test updated to reflect new behavior

## Notes

Priority P3 because the failure mode is operator-misconfig, not a user-visible defect. The fix is safe and trivial — bundle it with any other janitor work. Not worth a standalone PR.
