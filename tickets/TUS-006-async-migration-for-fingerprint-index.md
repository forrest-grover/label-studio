---
id: TUS-006
title: Convert fingerprint composite index to async migration pattern
status: open
priority: P2
area: backend
created: 2026-04-19
related_branch: tus-upload
related_commits: "6d20c3ea8 3a9ce334d"
---

## Problem

Migration `0003_fileupload_created_at_fileupload_fingerprint_and_more.py` adds a composite index `(project, fingerprint)` via `migrations.AddIndex`, which runs synchronously inside Django's migration runner. On a `FileUpload` table with tens of millions of rows (realistic for enterprise installs), a synchronous `CREATE INDEX` on Postgres can take many minutes — easily exceeding CI/CD migration timeouts (typically 5-15 min).

This violates `.cursor/rules/async_migrations.mdc`: any DDL that risks exceeding CI/CD timeouts or blocking writes on large tables should use the async-migration pattern (`start_job_async_or_sync` + `CREATE INDEX CONCURRENTLY`).

The `AddField` operations on `fingerprint` (nullable CharField) and `created_at` (nullable DateTimeField with `auto_now_add`) are metadata-only on Postgres and do not need this treatment — only the index does.

## Proposed fix

Split the index operation out of migration 0003 into a new migration 0004 that follows the async pattern from `async_migrations.mdc`:

- `atomic = False` on the new migration
- `RunPython(forwards, backwards)` wraps `start_job_async_or_sync(forward_migration, migration_name='0004_fileupload_fingerprint_composite_index')`
- `forward_migration`:
  - Postgres: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "data_import_fu_proj_fp_idx" ON "data_import_fileupload" ("project_id", "fingerprint")`
  - SQLite fallback: `CREATE INDEX IF NOT EXISTS ...` (no CONCURRENTLY)
  - Track progress via `AsyncMigrationStatus`
- `reverse_migration`: `DROP INDEX CONCURRENTLY IF EXISTS ...` on Postgres, regular DROP on SQLite
- Remove `indexes = [models.Index(...)]` from `FileUpload.Meta` in `models.py` to prevent Django from re-emitting an `AddIndex` op on the next `makemigrations`
- Because migration 0003 has already been applied on dev (and any deployments that have pulled `tus-upload`), migration 0004 must be idempotent: `IF NOT EXISTS` handles the case where the index already exists from the 0003 sync op

## Acceptance criteria

- [ ] New migration 0004 exists and follows the `async_migrations.mdc` template
- [ ] Migration 0003's `AddIndex` op removed; model `Meta.indexes` removed
- [ ] `makemigrations --check` clean
- [ ] Migration applies cleanly on: (a) fresh DB (fresh Postgres, fresh SQLite), (b) a DB that already has the sync index from 0003 (idempotent)
- [ ] `_find_existing_fileupload` dedup tests still pass (index name must match)
- [ ] Unit test for the new migration: forward + reverse, both Postgres-simulated (using SQLite is acceptable since Django's migration executor is vendor-agnostic at the ORM level)

## Notes

Low-urgency because current users of this branch are on dev Postgres with small `FileUpload` tables; the issue only bites at scale. Blocks any attempt to upstream this branch to `HumanSignal/label-studio` since upstream CI runs against production-sized fixtures.

Related rule: `.cursor/rules/async_migrations.mdc` — see the template section.
