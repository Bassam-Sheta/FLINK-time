# Routed entry audit recovery — development plan and evidence

Base revision: `1be27124948e14c0c87423a57da225cb9e081c27` (WP10 draft).
Requirements: `SYSTEM_SPEC.md`, yearly entry routing and data integrity sections.
No production activation, installer-pin change or Google modification is authorized
by this offline work. Preserve the five deployment files, mandatory MFA, current
service authorization, immutable row locations and unrelated work.

## Bounded implementation

1. Reproduce missing append/update completion pairs after applied Sheet writes in
   `tests/yearly-entry-audit-recovery.test.js`, using the existing synthetic fixture.
   Verify assertion failures against the base before changing the backend.
2. Add an internal `YearlyEntryMutation` boundary inside `apps-script/Code.gs`:
   one HMAC-authenticated checkpoint row per Core, bound to workspace/Core/owner,
   retaining the operation, actual actor and complete Before/After snapshots.
   Initialize before owner activation; missing/corrupt active evidence fails closed.
3. Persist the pending checkpoint before intent/data writes under ScriptLock.
   A subsequent authorized writer or private owner recovery helper compares the
   immutable entry's full row and physical cohort to the signed snapshots. Repair
   only matching applied/unapplied outcomes; never reapply or roll back data.
   Preserve the original mutation actor and separately attribute recovery.
4. In `YearlyBackupSets`, include the checkpoint in authenticated manifests, reject
   pending recovery before copying, and rebind only verified idle copied checkpoints.
5. Test audit/flush/checkpoint interruptions, unapplied writes, tampering, stale
   snapshots, row movement, explicit actors, lock ownership, bounded checkpoint
   reads, backup isolation and restored writes. Run targeted and full Node tests,
   mocked Chrome tests, dependency audit and diff checks before commit/push.

## Semantics and limits

- At most one pending routed entry mutation per Core; no growing repair-log scan.
- Flush/audit failures remain failures. Durable evidence is retained, not deleted.
- Re-emitted audits may duplicate the same correlation after an uncertain result;
  this is at-least-once evidence, not exactly-once Sheets transactions.
- Recovery never grants a session or mutation permission. Caller authorization
  remains in the existing application services; editor recovery is owner-only.
- A row matching neither snapshot blocks writes/backups for owner reconciliation.
  No blind recreation, forged checkpoint, fallback route or cleanup is permitted.
- This does not repair older uncheckpointed operations, Core-only legacy mode,
  other tables, schema-setup audit pairs, application-level side effects (including
  timer rollup reconciliation) or partial backup sets. It is not an upgrade tool
  for previously active draft storage/snapshots lacking the journal; missing signed
  evidence requires separate owner reconciliation, never silent initialization.
- Live Google behavior, root/MFA setup, privacy/sharing and deployment acceptance
  remain separate gates. The existing staging deployment stays at its verified pin
  until a separately verified upload/deployment is performed.

## Recovery runbook (approved synthetic resources only)

1. Use matched application source and privately owned Core/Data resources. Owner
   activation initializes the checkpoint before enabling yearly routing. Existing
   active draft resources lacking it are not eligible for automatic migration.
2. A failed writer remains failed. Preserve the original checkpoint and audits;
   do not clear it, change a row to match it, or repeat an uncertain create.
3. A later authorized entry writer automatically repairs pending evidence before
   its own entry mutation. Timer Stop's existing-entry repair/replay paths also
   run entry audit repair before acknowledging success. Ordinary read-only entry
   access does not mutate the journal or imply that recovery has completed.
4. Alternatively the installation owner invokes private editor helper
   `recoverYearlyEntryMutation_(workspaceId)`. Owner identity is checked before and
   after waiting for ScriptLock. No public RPC/action/menu was added.
5. COMPLETED means the full After row hash and immutable physical cohort match.
   NOT_APPLIED means the Before state matches (including absence for append).
   Neither path changes entry data. Re-emitted original actor audits keep the same
   operation; separate recovery audits identify the initiator and outcome.
6. A row matching neither snapshot, missing/invalid signature, foreign binding,
   unexpected headers or extra checkpoint rows returns CONFLICT and retains
   evidence for owner review. Do not fall back to Core or initialize missing active
   evidence. Audit/flush uncertainty similarly retains pending state for retry.
7. Only after terminal audit flush is the slot cleared. File-set backup refuses
   pending evidence before copying; verified idle copies receive their own Core
   binding/signature. Backups cannot masquerade as live recovery evidence.

## Review and evidence

The first three regressions failed against the base with expected assertions:
missing original append completion, missing original update completion, and a
backup incorrectly proceeding while entry auditing was unresolved. An additional
Stop regression failed before repair was attached to its early-return paths.

The complete new synthetic suite covers applied/unapplied writes, audit absence
and uncertain success, flush/checkpoint failures, corrupted readback, tampering,
owner/actor/lock guards, moved rows, fixed-size reads, payload limits, copied/restored
checkpoints and timer retries. VM-realm objects are compared as canonical audit
JSON; restore fixtures include independently known rollup totals, without disabling
the rollup-integrity check. No real credentials, email or Google resources are used.

The checkpoint adds fixed metadata and verification work under ScriptLock. It does
not establish a live latency/cell-transfer improvement. Snapshots contain the same
entry fields already required in privileged audit history, not new credentials.
An idle checkpoint retains no entry snapshot. Editors remain privileged; this is
not protection from an editor who controls source/keys or can roll back signed
infrastructure. Existing audit anchors and access restrictions remain necessary.

Official Apps Script `SpreadsheetApp.flush()` reference was consulted on
2026-10-15: it applies pending spreadsheet changes; it does not promise a multi-file
transaction. No transactional, quota or live acceptance guarantee is inferred.
Reference: https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app#flush()

Verified 2026-10-15 after the final backend/test change:

- `node --test tests/yearly-entry-audit-recovery.test.js`: **22 passed**.
- `node --test --test-reporter=spec 'tests/*.test.js'`: **608 passed**, zero
  failed/skipped/cancelled. Existing deliberate failure-injection notices include
  denied audits, uncertain flushes, fixture fallback notices and preserved restore
  candidates; none was suppressed or reclassified as live acceptance.
- `node node_modules/playwright/cli.js test --config .opencode/browser-control/chrome.config.cjs`:
  **14 passed**, synthetic RPC mocks, signed installed Chrome with sandbox enabled.
- `npm audit --json --ignore-scripts`: **zero known vulnerabilities** (72 developer
  dependencies in the audit inventory); no package installation or update.
- Complete local Node/browser logs are retained under the approved local temp
  directory, named `flink-unit-recovery-20261015-165351071.log` and
  `flink-chrome-recovery-20261015-165351059.log`. No raw Google artifact was uploaded.

These checks cover this follow-up's backend/test bytes, not deployment or Google
identity/storage semantics. The live browser attempt reported main Chrome
connection unavailable; `node scripts/staging.js doctor` reported missing local
configuration, no Google calls, and no runtime/upload readiness. The verified
earlier staging deployment is unchanged; production and installer pins are untouched.
