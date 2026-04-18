---
id: TUS-005
title: Server-side fingerprint dedup for XHR-in-flight-on-unload race
status: done
priority: P1
area: backend
created: 2026-04-18
related_branch: tus-upload
related_commits: ""
---

## Problem

Even after TUS-004 (pagehide flush), tier_resume.py still intermittently produces 192/191 FileUpload rows. Root cause is distinct from the debounce race: if a tab reload fires while tus-js-client's final-chunk PATCH is in-flight, the server completes the upload and creates a FileUpload row, but the client-side `onSuccess` handler never runs because the response never reaches the cancelled document. Consequently `markComplete` is never called, the completed fingerprint never lands in the client index, and on re-drop the file is uploaded again — producing a duplicate FileUpload row.

This is inherent to any client-side-index approach and cannot be fully solved on the frontend.

## Proposed fix

Server-side idempotency by fingerprint. Client passes a fingerprint metadata field on the initial tus `POST /files/` request (the tus Upload-Metadata header supports arbitrary key-value pairs; `<name>:<size>:<lastModified>` is already computed by `fingerprintForFile`). On finalize, before creating a new FileUpload row, the tus_app receiver queries for an existing row in the same project with the same fingerprint within the last N hours (configurable, default 24h). If one exists: return the existing row's ID, skip row creation, and delete the redundant `.data`/`.meta` files.

- Client: add `lsFingerprint` to `metadata` in `tusUpload.js` when creating the tus `Upload` instance.
- Backend: persist `fingerprint` on the FileUpload model (new nullable column + migration). Index it together with `project_id` for fast lookup.
- Backend: in `tus_app/receivers.py` (or equivalent finalize handler), check for existing row by `(project_id, fingerprint)` within the TTL window. If hit: reuse; if miss: create.
- Setting `TUS_SERVER_DEDUP_WINDOW_HOURS` default 24.

## Acceptance criteria

- [ ] tier_resume.py passes at 191/191 across 5 consecutive runs (intermittency currently reproduces in 2/3 runs)
- [ ] Tier-4 throughput unchanged (no DB-lookup regression — the per-row lookup must be indexed)
- [ ] Backend unit test: two tus uploads with same metadata fingerprint to same project create exactly one FileUpload row
- [ ] Migration adds the column + composite index without requiring downtime (nullable, no backfill needed)
- [ ] Old clients without the metadata field still work (fingerprint column just stays null → no dedup benefit but no breakage)

## Notes

Complements TUS-001 client-side dedup — client still catches the common case without a DB round-trip; server dedup catches the in-flight-on-unload edge case TUS-004 could not. After this ticket, TUS-001's completedFingerprints index is still useful because it shortcuts enqueue without a server round-trip.
