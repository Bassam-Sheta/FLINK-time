# Restore failure recovery — 2026-10-06

Branch: `restore-failure-recovery`.
Base: `bf29b6b732374bfe51ffc083d260acbed16a7ed7`.
Scope: `BackupService.restoreBackup` failure handling and audit/flush boundaries.

## Reproduced failure

The original catch block always trashed the newly created candidate, even if it
was still the registered live workspace and rollback had failed. It then claimed
the restore "was rolled back". The first synthetic fault test reproduced exactly
that sequence. Additional tests reproduced ignored completion-audit failures,
unflushed rollback, stale rollback-target snapshots and writes that applied before
throwing. **11 of the initial 12 tests failed before the fix.**

## State transitions

1. Acquire ScriptLock, discard pre-lock workspace snapshots and read the current
   ACTIVE pointer. Verify the registered backup and create a safety snapshot.
2. Create a distinct candidate and verify its content/schema/rollup totals.
3. Persist and flush `RESTORE_INTENT` with Before/After state and rollback target.
   Candidate file ID correlates the subsequent records; passwords/hashes are absent.
4. Mark the workspace-mutation attempt before the first status write; mark the
   pointer-switch attempt before its write. A backend error cannot prove no effect.
5. Clean candidate timers, switch in MAINTENANCE, revoke member sessions and flush.
6. Write ACTIVE, require `RESTORE_COMPLETED`, then flush before returning success.
7. On failure, attempt the original ACTIVE pointer, flush and discard caches before
   reading it back. Only that read can confirm rollback.
8. Unconfirmed rollback preserves the candidate and tries to set MAINTENANCE.
   Backend failure can also defeat this containment; the response reports recovery
   required without asserting that isolation succeeded.
9. Cleanup requires a known newly created candidate, no uncertain workspace state,
   and either no pointer-switch attempt or verified detachment. Its audit intent
   must flush before trashing. Failure metadata distinguishes preserved, trashed,
   absent and unknown cleanup results.

## Verification

- **424/424 unit tests pass**, including **16 new behavioral restore tests**.
- Cases cover failed/no-op rollback, writes applying before throwing, read/flush
  outages, pre-lock snapshots, audit outages, final flush failure, containment,
  refused unaudited cleanup, lock timeout, and successful completion/rollback.
- Backend syntax checks in the repository suite and `git diff --check` pass.
- No new dependencies or portal changes. No live restore or browser-backend
  integration was executed for this package.

This is independent of `review-current-security` (step-up hardening). Both start
at the same GitHub baseline; neither contains the other's code changes, nor
the earlier WP0/WP1/WP2 work. Counts describe separate suites, not a combined release.

## Interrupted or unconfirmed recovery

An Apps Script termination can skip catch/finally entirely. Sheets, Drive and
Properties do not provide a cross-service transaction. The durable intent records
the original/candidate/backup IDs before the pointer switch; completion/failure
records provide additional evidence when available. Final error/audit recording
can itself fail during an outage. Automatic resumable restore is still pending.

For an owner-approved recovery on a staging copy first:

1. Locate the correlated `RESTORE_INTENT`, `RESTORE_COMPLETED`, `RESTORE_FAILED`
   and cleanup-intent records. Read the actual Master workspace row rather than
   trusting the last response or browser cache.
2. Preserve the original, candidate and registered backups while determining
   which file is referenced. Resolve an unknown status before reopening access.
3. Verify the chosen dataset against its schema, registered content manifest,
   raw totals, rollups and audit history. A failure after activation may have left
   a valid candidate or partially revoked sessions; do not infer lost data solely
   from a failed response.
4. Apply the explicitly chosen pointer/status with attributed Before/After
   auditing under the writer lock, flush, then independently reread. Verify member
   sessions and active timers before reopening the workspace.
5. Only clean detached owned candidates after confirming all references. This
   package does not automatically delete retained recovery material.

Remaining release gates: integrate current session/reauthentication hardening;
check live Google flush/read behavior, concurrent readers/writers and restore
interruption; bound long restore/backup work with durable continuation. Direct
Sheet/project editor changes remain outside application-lock enforcement.
