---
id: TUS-002
title: Tier-4 second-half upload throughput degradation
status: open
priority: P3
area: both
created: 2026-04-18
related_branch: tus-upload
related_commits: ""
---

## Problem

During the Tier-4 stress test (7980 files / 20 GiB), throughput dropped significantly between the first and second halves of the run:

- First half: ~7.7 files/s
- Second half: ~3.5 files/s
- Aggregate time: 34m17s (~10 MB/s mean)

Server metrics during the slow half: App CPU 15–55%, nginx <5%. Client metrics: Playwright browser CPU 132–214%, heap high-water 104 MB (bounded). The server is not saturated; the bottleneck is client-side or in uWSGI worker lifecycle interaction.

Suspected contributors (none verified):

- uWSGI worker recycling at `max-requests` or lifetime boundary mid-run (`deploy/uwsgi.ini`)
- Accumulating tus localStorage fingerprint entries increasing key lookup cost over the run
- React DevTools / profiler overhead active during the test inflating browser CPU numbers

## Proposed fix

Profile a fresh Tier-4 run without DevTools attached and with uWSGI recycle events logged (add a `--log-format` entry for worker respawn). Correlate worker-respawn timestamps against the throughput timeline.

- If uWSGI recycling correlates: raise `max-requests` on upload workers or pin uploads to a dedicated worker group.
- If fingerprint-index growth correlates: prune the tus localStorage index more aggressively mid-run (ties into TUS-001 cleanup work).
- If neither correlates: heap/GC profiling in Chrome to identify the client-side regression.

## Acceptance criteria

- [ ] Root cause identified with evidence (profiler output or log correlation, not guesswork)
- [ ] Tier-4 throughput variance between first and second half is <20%
- [ ] Aggregate Tier-4 time improves, or documentation explains why the current number is the practical floor

## Notes

Tier 4 currently PASSES cleanly — this is a perf-polish ticket, not a correctness issue. Low priority until TUS-001 is resolved, since a re-run after that fix may shift the numbers anyway.
