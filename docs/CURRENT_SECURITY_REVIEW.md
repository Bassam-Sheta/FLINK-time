# Current-source review — 2026-10-06

Reviewed GitHub `main` at `bf29b6b732374bfe51ffc083d260acbed16a7ed7`
(Milestone 31), independently of the earlier offline branches based on `9e6db78`.
This branch is the privileged-reauthentication hardening/review work package.
No deployment or live data mutation was performed.

## Verified fix in this work package

`AuthService.stepUp` previously performed replay checking and credential/session
rotation without serializing that state transition. A second request could consume
the same TOTP, or change credentials/account state between verification and use.

The fix retains expensive verification outside ScriptLock, but refreshes durable
state and consumes the timestep inside it. It also checks exact session deadlines,
identity, role/status, epochs, lockout, credential generation and elapsed TOTP
window; stale request-local table snapshots cannot satisfy these checks.

Redacted intent/completion audits are required. The intent and completion are
flushed under the lock; partial failures attempt replacement revocation and grant
deletion before release. Malformed or exactly-expired step-up grants are rejected.
These checks do not make unrelated writers transactional or fix all session-cache
races; those remain separate integration work.

Evidence:
- Unmodified current baseline: **408/408 unit tests**.
- Initial race regressions: **5 of 6 failed** on the prior implementation.
- Additional stale-snapshot, malformed-state, completion-flush and expiry
  regressions reproduced their respective failures before the final corrections.
- Final current package: **421/421 unit tests**, including 13 new behavioral tests;
  **4/4 configured mocked Chromium tests**. Syntax tests and `git diff --check` pass.
- Browser tests reused the already-installed pinned Playwright from the earlier
  tooling worktree. They execute synthetic RPC responses, not the Google backend.

## Remaining findings, in implementation order

| Priority | Evidence / affected path | Impact and required correction |
| --- | --- | --- |
| High | `AuthService.login`, `SessionService.createSession`, `SETTINGS_CATALOG.MFA_REQUIRED` | Accounts without enrolled MFA receive unrestricted sessions. The flag does not enforce mandatory enrollment. Port the restricted-session WP2 design, migrate schema, prove owner/KMS bootstrap and recovery before rollout. |
| High | `AuthService.enrollMfa`, `disableMfa`, `verifyMfa`, `_storeMfaChallenge` | Enrollment/disable paths still have mutable-state races; current login challenges do not bind password generation/account epoch. Use durable generation binding, replay checks under the writer lock and mandatory-MFA policy. |
| High | `SessionService._getCachedSession`, `_putCachedSession`, `validateSession`; `MasterRepository` user cache | Five-minute backend TTL is the only cross-request freshness bound. Delayed cache writers can republish stale authorization; malformed fields and shifted rows need fail-closed handling. Reconcile the earlier WP1 deadline/locking work against this newer baseline. |
| High; fixed in separate local package | `BackupService.restoreBackup` catch/rollback | Baseline trashes the candidate even when rollback fails and a workspace still points to it. Branch `restore-failure-recovery` now preserves uncertain candidates, verifies flushed rollback, enforces restore/cleanup audits and reports incomplete recovery. Its 424/424 unit tests pass (16 new restore cases). Integration with this branch is pending. |
| High | `TimeEntryService.updateEntry`, `AuditService.logEvent`, `SheetRepository.logWorkspaceAudit` | Some mutations write first, ignore audit failure or swallow flush failure. Success can be returned without the required recoverable Before/After history. Introduce durable intent/completion and repair checkpoints for each mutation. |
| High | `SheetRepository.listTimeEntries`, report/rollup paths | Filters run after reading the growing full table. Master TextFinder tests do not bound these reads or full-request latency. Add immutable data-book locators, bounded month indexes including backdated/noncontiguous rows, and whole-request cell/call budgets. |
| High | `WorkspaceRouter`, `JobService.getCapacityMetrics` | Production uses a workspace spreadsheet and 60/75/85% monitoring, not Core + yearly Data files with pre-70% rotation. Implement actual-file rollover based on allocated cells plus pending allocation. |
| High before integration | `storage-v2/PartRouting.gs:createUserGate`, `planNewWrite` | Prototype gate relies on an evictable/expiring cache flag while writes occur outside the lock. Concurrent writers can overlap; next allocation is not counted and the cell count can be stale. Use real serialization/durable ownership and reserved capacity. |
| High before integration | `storage-v2/TrackerService.gs:startTimer`, `addManual`; `PartStore.gs` | Entry IDs embed the current part, so retries after rotation can create duplicates. IDs lack full immutable routing context. Tail/full-column searches and log/data interruption also need bounded lookup and recovery. These files are not referenced by production `Code.gs`. |
| Medium / required design | `User.html:onTimerProjectChange`, matching portal handlers; prototype `startTimer` | Production project selection only reloads tasks; prototype switching is stop+start. Neither implements moving the entire running timer to the chosen project. Test retained start/time, retry and unrelated stopped-entry edits. |
| Medium / required design | `FEATURE_TIMESHEET_APPROVAL`, dispatch and portal submission controls | Approval flag defaults off but approval remains callable/visible. Attach server guards and matching UI behavior. Stopping already persists an entry; optional approval must not gate completed-time storage. |
| High / required design | `ACTION_PERMISSIONS`, `AuthorizationService`, `WorkspaceAccess` | Role/workspace checks exist, but granular manager capabilities are not implemented. Enforce action/resource grants server-side, including deny cases and account lifecycle races. |
| High / required design | `PASSWORD_RECOVERY_EMAIL`, auth actions | Email recovery is only a catalog placeholder; recovery-code storage/consumption is absent. Implement one-use, generation-bound recovery with durable attempts and continued MFA enforcement. |
| High at scale | `JobService.runHousekeeping`, `AuditService.createAuditCheckpoint`, backup/restore verification | Whole-table/all-workspace work and long script-lock spans can exceed six minutes or block tracking. Chunked manifest reads bound memory, not total execution. Add durable continuation, bounded lock duration and interruption/restart tests. |
| High | Audit checkpoint retention paths in housekeeping and `createAuditCheckpoint` | Checkpoint deletion can proceed after failed archival. Script Properties anchors share the project's administrative trust boundary and finite 500 KB store; they are not independent protection against project editors. Require confirmed archival and capacity-bounded retention. |
| Medium | `apps-script/appsscript.json`, `JobService.ensureScheduledTriggers` | Runtime explicitly declares scopes but omits `script.scriptapp` required for trigger management. Verify owner consent/trigger installation in staging and reconcile scopes in its own package. Mail scope is also absent because recovery is not implemented. |
| Medium | `.github/workflows/stabilization-tests.yml:46`, root package tooling | Current branch uses `npm install` without a committed lockfile or install-script block. Reconcile reviewed WP0 frozen tooling; do not infer that its audit result covers an unpinned new install. |
| Release gate | `installer/Code.gs:INSTALLER_RELEASE` | Installer is pinned to `ba3cb0408a867fd48ea5948e3f0a88b39e139739`, not reviewed HEAD. Updating source does not update installed releases. Pin only a verified merged release and validate bootstrap separately. |

## Boundaries and positive controls checked

- Five-file production source contract remains intact; no external backend or CDN
  script was added. KMS remains the existing Google Cloud integration. Removing it
  or changing provisioning is not part of this fix.
- Server action allowlists, domain-restricted execute-as-deployer deployment,
  server-observed email binding and protected root-account checks exist.
- Privileged portals retain frame blocking. The requested three-Sites deployment
  still needs an explicit privileged-embedding decision; query arguments cannot
  establish the parent Site's identity.
- PBKDF2 remains the password KDF; KMS ciphertext is user-bound and failures do not
  fall back to legacy encryption. Live KDF/KMS cost and provisioning remain untested.
- API DTO allowlists, formula neutralization, optimistic entry versions, timer
  operation IDs, backup content hashes and audit HMACs are valuable existing
  controls. Their presence does not establish end-to-end recovery or bounded cost.
- Browser bearer tokens remain in sessionStorage. MFA and mocked browser success
  do not remove the need to prevent XSS or validate real Google identity behavior.

## Integration and live acceptance

WP0/WP1/WP2, this branch and `restore-failure-recovery` are independent work
packages. They have not been combined or squash-merged. Their test counts cannot
be added together to claim a tested release. Resolve dependencies explicitly.

After local integration, repeat the combined unit/browser checks and the locked
dependency audit. Publication uses the owner's verified GitHub no-reply identity.
Live Google testing additionally needs an approved synthetic staging
project, owner OAuth consent, KMS/IAM configuration and deployment settings.

Measure real cold/warm request latency, transferred cells, concurrent tracking,
lock contention, exact identity behavior, trigger creation, interrupted recovery
and restore on copies. Verify Sites behavior separately. No production readiness,
zero-bug result or 99% token saving is established by this offline review.

References checked against official documentation:
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/apps-script/reference/lock/lock
- https://developers.google.com/apps-script/reference/cache/cache
- https://developers.google.com/apps-script/reference/script/script-app

Reviewed skill selection and the installed text-only project skill are recorded in
[`SKILL_SECURITY_REVIEW.md`](SKILL_SECURITY_REVIEW.md).

Publication follow-up: the WP0 native audit now reports an unpatched developer-only
`braces` advisory through clasp. WP0 pins the CLI's project/ignore inputs and
documents residual exposure in `docs/DEPENDENCY_REVIEW.md`; its audit gate still
fails. WP2 now passes 285 unit and 7 mocked browser tests, with mandatory MFA also
shown as enabled/read-only in the settings catalog. Migration/integration gates
remain open.
