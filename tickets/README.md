# tickets/

Local ticket schema for post-initial-tus-upload work. One file per ticket.

## File naming

`TUS-NNN-slug.md` — NNN is zero-padded to three digits.

## Frontmatter fields

| Field | Values |
|---|---|
| `id` | TUS-NNN |
| `title` | concise, imperative |
| `status` | open \| in-progress \| done \| wontfix |
| `priority` | P1 (urgent/correctness) \| P2 (important) \| P3 (polish) |
| `area` | backend \| frontend \| both |
| `created` | YYYY-MM-DD |
| `related_branch` | git branch this work targets |
| `related_commits` | space-separated short SHAs, or empty string |

## Body sections

`## Problem`, `## Proposed fix`, `## Acceptance criteria`, `## Notes` — see TUS-001 for the canonical example.

## Current tickets

| ID | Title | Priority | Status |
|---|---|---|---|
| TUS-001 | Resume banner allows duplicate uploads | P1 | open |
| TUS-002 | Tier-4 second-half throughput degradation | P3 | open |
| TUS-003 | Janitor for orphaned tus temp files | P2 | open |
