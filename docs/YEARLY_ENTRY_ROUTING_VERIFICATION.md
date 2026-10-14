# Yearly entry routing — work in progress

Branch: `wp10-yearly-entry-routing`. No deployment or live activation performed.

Offline verification (2026-10-14): 577 unit tests and 14 existing mocked
Chromium tests pass; `git diff --check` passes. Browser tests do not exercise
Google file creation or multi-file restore.

Implemented locally:
- Entry-only `YEARLY_ENTRIES_V1` routing, legacy Core reads, start-year allocation,
  immutable historical locations, replay detection and audited mutations.
- File-set backups with authenticated manifests, isolated restore copies,
  rewritten Core/Data references, rollback policy restoration and retention guards.
- Cross-file report/rollup inputs and per-file capacity accounting.

Not release-ready: final security/reliability review and rollout specification
remain outstanding. Do not invoke `enableYearlyEntryStorage_` in production.
This routes TimeEntries only; other growing tables remain in Core. Chunked reads
still accumulate whole report datasets; bounded end-to-end reporting/jobs are not
completed. File-set backups cap synchronous work at 64 Data files and a four-minute
budget; partial copies are deliberately retained for owner reconciliation, not
automatically resumed or deleted. Google quotas and permissions are unverified live.

Before marking the draft PR ready, review actor attribution, interrupted activation/completion,
retry payload conflicts, row/version races, backup audit completion and recovery
of partial file sets. Update the canonical specification and activation runbook.
