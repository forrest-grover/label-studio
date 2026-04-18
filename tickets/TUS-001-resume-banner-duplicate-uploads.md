---
id: TUS-001
title: Resume banner allows duplicate uploads for completed files
status: open
priority: P1
area: frontend
created: 2026-04-18
related_branch: tus-upload
related_commits: ""
---

## Problem

`removeFingerprintOnSuccess: true` is set in `tusUpload.js:59`. When a user uploads a large file set, reloads the tab mid-way (e.g., at ~40% progress), and re-drops the same file set to resume, any files that fully completed before the reload have had their tus fingerprints wiped. tus-js-client treats those as fresh uploads, and the server creates duplicate `FileUpload` rows.

Observed during Tier-resume testing: 273 `FileUpload` rows for a 191-file set (~40% duplication). The Resume banner appears and counts interrupted uploads correctly — that part works. The bug is in re-uploads of already-completed files.

## Proposed fix

Track a per-project "completed fingerprints" index in localStorage (separate key from tus's own index). On re-drop, the `onUpload` handler in `tusResume.js` (or equivalent) filters out any file whose fingerprint — computed as `<name>:<size>:<lastModified>`, matching how tus-js-client derives its own key — appears in the completed set for the current project. TTL the index entries at 7 days to avoid unbounded growth.

- Add a `completedFingerprints` module alongside `tusResume.js` that exposes `markComplete(projectId, fingerprint)`, `isDuplicate(projectId, fingerprint)`, and `pruneExpired()`.
- Call `markComplete` inside the `onSuccess` handler in `tusUpload.js` before `removeFingerprintOnSuccess` wipes the tus entry.
- Call `isDuplicate` before enqueuing a file in the upload queue; skip + log if true.
- Call `pruneExpired` once per Import-page mount.

Alternative considered: Banner's "Resume" button opens a filtered file picker showing only interrupted uploads. Rejected — forces users to retain original files and cannot distinguish completed vs. interrupted without the index anyway.

## Acceptance criteria

- [ ] Repro scenario (drop N files, reload at ~40%, re-drop same N files) produces exactly N `FileUpload` rows
- [ ] Resume banner still appears and counts interrupted uploads correctly
- [ ] Completed-fingerprint index is keyed per project (`ls-tus-completed-<projectId>`) and pruned after 7 days
- [ ] Unit test covering the dedup logic in `completedFingerprints.js` (or wherever the index lives)

## Notes

This is the one known correctness issue that caused Tier-resume to be PARTIAL rather than PASS. Happy-path uploads (no reload) are unaffected. Related to TUS-003 in that both involve cleanup of stale state; the 7-day TTL mirrors the proposed server-side orphan TTL.
