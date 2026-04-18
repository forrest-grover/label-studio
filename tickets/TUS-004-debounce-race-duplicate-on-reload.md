---
id: TUS-004
title: Debounce flush race drops one completion on reload
status: done
priority: P1
area: frontend
created: 2026-04-18
related_branch: tus-upload
related_commits: "3b210d145"
followup: "TUS-005 covers the remaining XHR-in-flight race not addressable from the frontend"
---

## Problem

TUS-002 introduced an in-memory `Map` mirror + 1s debounced flush to localStorage inside `completedFingerprints.js` to eliminate an O(N²) per-completion write cost. This reintroduces a TUS-001 regression in the reload scenario: completions that land in the Map within the 1s window before a tab reload never reach localStorage. On re-drop, those files look fresh and get a new `FileUpload` row.

Observed under tier_resume.py after TUS-002: N=191, actual rows=192 (off-by-one). Pre-fix (commits `6c9e4d350` `dee9c2a11` `f3c2afcf2`) this scenario passed at 191/191.

## Proposed fix

Sync flush on `pagehide` (preferred over `beforeunload` — fires on mobile/tab-close and is not blocked by open confirm dialogs). Keep the 1s debounce for the common-case batching so the O(N²) regression from TUS-002 does not return.

- Register a single `pagehide` listener inside `completedFingerprints.js` module init that synchronously writes any pending Map deltas to localStorage and cancels the pending debounce.
- Make the flush idempotent so it can run multiple times without corrupting state.
- Unit test: simulate `pagehide` event, assert localStorage has all entries that were in the in-memory Map.

## Acceptance criteria

- [ ] tier_resume.py passes at 191/191 (no duplicate rows)
- [ ] Tier-4 throughput unchanged vs post-TUS-002 baseline (~17m30s, <20% variance)
- [ ] Unit test covers the pagehide-triggered sync flush
- [ ] No leaked listeners (listener is module-scoped, not per-mount)

## Notes

Regression introduced by commit `dee9c2a11` (TUS-002). Alternative considered: drop the debounce and always write synchronously — rejected because that re-introduces the O(N²) cost TUS-002 measured. Using `pagehide` preserves the optimization while covering the reload case.
