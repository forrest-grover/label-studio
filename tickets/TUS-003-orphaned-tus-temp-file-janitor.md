---
id: TUS-003
title: Janitor for orphaned tus temp files on TUS_UPLOAD_DIR
status: open
priority: P2
area: backend
created: 2026-04-18
related_branch: tus-upload
related_commits: ""
---

## Problem

The vendored tus app at `label_studio/data_import/tus_app/` writes per-upload state as `<uuid>.meta`, `<uuid>.data`, and `<uuid>.done` files under `TUS_UPLOAD_DIR` (default: same volume as `MEDIA_ROOT`). If a client abandons a mid-upload session (tab closed, network failure, browser crash), the `.meta` and `.data` files remain on disk indefinitely. No background sweeper exists. Over weeks or months of production use this causes unbounded disk growth.

## Proposed fix

Add a periodic task (verify whether the project uses rq or celery, then use whichever is already wired) that scans `TUS_UPLOAD_DIR` for `.meta` files whose mtime is older than a configurable TTL, then deletes the paired `.meta` and `.data` files. Skip any pair that has a corresponding `.done` marker newer than their `FileUpload` DB row's `created_at` (i.e., a recently finalized upload that hasn't been ingested yet).

- Add `TUS_ORPHAN_TTL_DAYS` to settings with a default of 7.
- Register the task in the existing scheduler config; run daily.
- Log file count and bytes freed at INFO level on each run.

## Acceptance criteria

- [ ] Scheduled job registered in the repo's task-scheduler config (rq or celery — verify first)
- [ ] `TUS_ORPHAN_TTL_DAYS` setting present with default 7
- [ ] Unit test using a temp directory: verifies age-based deletion and `.done`-skip logic
- [ ] Logging on cleanup: file count + bytes freed

## Notes

Flagged as optional in design doc §B6. Priority P2 because it is a correctness issue (disk pressure) but not user-visible in the short term. `.done` markers can be retained longer or tombstoned to a separate directory if the skip logic proves unreliable.
