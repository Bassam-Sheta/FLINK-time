# Yearly entry routing — work in progress

Branch: `wp10-yearly-entry-routing`. No production deployment or live activation.
The earlier `1be2712` source was deployed to the approved owner-only staging Web
App (Version 2); only first-run rendering was observed. The entry-audit recovery
follow-up described below has not been uploaded or deployed.

Offline verification (2026-10-15): 608 unit tests and 14 existing mocked
Chrome tests pass; `git diff --check` passes. Browser tests do not exercise Google
file creation or multi-file restore.
The native npm audit reports zero known vulnerabilities. No staging configuration
is present, so live Google acceptance, activation, release merge and installer-pin
changes remain gated. This branch remains separate from the WP11 lean-source draft.

Implemented locally:
- Entry-only `YEARLY_ENTRIES_V1` routing, legacy Core reads, start-year allocation,
  immutable historical locations, replay detection and audited mutations.
- File-set backups with authenticated manifests, isolated restore copies,
  rewritten Core/Data references, rollback policy restoration and retention guards.
- Cross-file report/rollup inputs and per-file capacity accounting.
- Complete-row snapshot checks inside the writer lock (including lock/approval
  changes without a version bump), sanitized updated return values/current locators,
  and mandatory explicit mutation actors for single/batch entry writes.
- A bounded authenticated activation checkpoint preserving the original owner,
  Before policy and operation across failed verification, applied policy writes,
  completion-audit failures and checkpoint-write uncertainty. It is included and
  rebound in isolated backup/restore sets.

Not release-ready: final security/reliability review and production rollout approval
remain outstanding. Do not invoke `enableYearlyEntryStorage_` in production.
This routes TimeEntries only; other growing tables remain in Core. Chunked reads
still accumulate whole report datasets; bounded end-to-end reporting/jobs are not
completed. File-set backups cap synchronous work at 64 Data files and a four-minute
budget; partial copies are deliberately retained for owner reconciliation, not
automatically resumed or deleted. Google quotas and permissions are unverified live.

Before marking the draft PR ready, finish broad actor/permission freshness review,
application-wide mutation audit recovery, backup completion/partial-set recovery
and bounded end-to-end reporting/jobs. Routed entry checkpoint repair is covered
in `ENTRY_MUTATION_RECOVERY.md`; it does not repair other tables or older operations.
The activation, row-race and entry-recovery regressions are
offline evidence, not live Google concurrency acceptance. The canonical
specification now describes this draft without authorizing production activation.

Retry conflict review: append accepts an existing EntryID only when every schema
field matches the sanitized proposed row. A changed payload, including a retry
after a subsequent edit, fails with CONFLICT rather than silently acknowledging
the wrong mutation. A failing regression was reproduced before the fix; the earlier
retry-only follow-up passed 578 unit tests. Current counts are at the top of this
document. Browser files were unchanged by the backend follow-ups.

Entry audit recovery follow-up: 22 new regressions exercise the fixed signed
checkpoint, applied/unapplied outcomes, original actors/snapshots, owner-only
repair, uncertain audit/flush/checkpoint writes, corruption, bounded metadata,
backup/rebinding and Stop retries. Existing synthetic failure-injection notices
remain present in full-suite output. Source, runtime state and live acceptance
are not interchangeable evidence. See `ENTRY_MUTATION_RECOVERY.md` for limits.

## Synthetic activation and interrupted-operation runbook

This is a rehearsal procedure for an explicitly approved disposable installation,
not permission to run against production. Deploy only matched source, after the
staging/OAuth/MFA/KMS prerequisites in `STAGING_TESTS.md` have been approved.

1. Keep the original Core/private Data files and a validated legacy safety backup.
   Confirm the Master Workspaces schema, ACTIVE workspace and installation-owner
   identity. Do not share infrastructure with ordinary accounts.
2. Review the bounded DataFileRegistry: every prepared file must be READY, privately
   owned and bound to this workspace/Core/year/part. Non-TimeEntries Data tabs must
   contain only their recognized headers. Resolve uncertain creation IDs manually;
   never delete/recreate unknown files just to obtain a passing activation.
3. As the installation owner, invoke private `enableYearlyEntryStorage_(workspaceId)`
   in the editor. No UI setting/RPC activates routing. It retains legacy entries,
   initializes the fixed-size entry-mutation journal before writing the signed
   activation checkpoint, gates with YEARLY_ENTRIES_PREPARING,
   verifies, flushes the active policy and completion audit, then marks COMPLETE.
4. After an error, inspect both the durable policy and activation checkpoint without
   editing them. Once the policy transition begins, routed access/snapshots remain
   blocked until COMPLETE—even if the active-policy write already applied. Owner
   retry of the same helper reuses the recorded original Before/operation and
   re-verifies the file set. Before the policy transition, legacy Core storage can
   still operate safely; activation retry includes those legacy records.
5. Missing/invalid signed evidence on an active/pending workspace requires owner
   reconciliation; do not clear the policy, forge a checkpoint, disable auditing
   or enable fallback routing. No automated repair exists for that corruption.
6. Rehearse cross-year inserts, threshold rotation, changed historical dates,
   duplicate/replayed IDs, stale versions/lock changes, Stop without approval and
   actual manager/System actor attribution. Reconcile reports/rollups to raw rows.
7. Create/validate a complete isolated backup set; restore only to synthetic copies.
   Verify Core/Data/checkpoint bindings, entries, totals, permissions and audits.
   Incomplete activation or pending entry audit repair cannot publish a backup.
   Resolve exact Before/After matches with the private owner recovery helper;
   mismatches/missing checkpoints require separate reconciliation. Never initialize
   a missing active journal or use older draft snapshots without review.
   Retain partial copy IDs and their
   FILE_SET_COPY intent/registration audits for owner review; no resume/purge helper
   is authorized or implemented. Do not regard a retained partial set as a backup.

Checkpoint reads add fixed metadata work to routed requests; complete-row hashing
adds CPU work to loaded rows. Neither is a Google latency improvement claim.
Official Lock/quotas documentation refresh was attempted but network DNS failed;
no platform-limit or API-contract change is inferred from that missing evidence.
