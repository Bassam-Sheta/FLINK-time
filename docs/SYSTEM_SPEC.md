# FLINK Time — Final Canonical System Specification

## Final topology

```
Google Sites / Direct Web App Access
  ├── Employee page   -> Apps Script /exec?view=user        (Google Sites embed allowed)
  ├── Admin page      -> Apps Script /exec?view=admin       (direct access only)
  └── Super Admin page-> Apps Script /exec?view=superadmin  (direct access only)
                              |
                              v
                           Code.gs
                              |
             +----------------+----------------+
             |                |                |
        Master Sheet     Workspace Sheets   Google Drive
                                             + Script Properties
```

## Deployable source contract

The production application intentionally has only:
1. `Code.gs` — backend/API/security/data/business/admin logic plus the bound-Sheet installer menu.
2. `User.html` — employee portal; Google Sites embedding is allowed.
3. `Admin.html` — Admin/Manager portal; direct Web App access only.
4. `SuperAdmin.html` — Super Admin portal and first-run wizard; direct Web App access only.
5. `appsscript.json` — Apps Script manifest.

No other `.gs` file is required for deployment. npm, Node.js, Playwright, GitHub Actions, and repository tests are development-only.

### Developer runtime verification (WP0)

Clasp 3.4.1 is pinned in the developer lockfile. `npm run staging` prepares and
verifies an isolated, owner-approved diagnostic bundle; it rejects the declared
production script ID and requires explicit confirmation before upload/execution.
Its extra private diagnostics and owner-only API-executable manifest are staging
only, never part of the five-file production contract. See `STAGING_TESTS.md` for
authorization, scope, quota sources and the distinction between mocked tests,
runtime-primitives measurements and live application acceptance. Production
deployment, MFA and storage behavior have not changed in this package.

## Role surfaces

### USER portal
Timer, My Time, self-scoped Reports, Account.

### ADMIN portal
Personal Timer and My Time, Manager workspace, assigned-workspace Reports, Account.

### SUPER_ADMIN portal
Personal Timer and My Time, Super Admin control center, Manager workspace, Reports, Account, first-run setup.

Client-side portal separation is a usability layer only. Server-side `ACTION_PERMISSIONS`, session validation, workspace ACLs, and role checks remain the security authority.

## Authentication
- `handleClientRequest` is the application RPC bridge. `onOpen` is the only additional public simple-trigger function and only adds the harmless FLINK Time menu to the bound Sheet; every installer menu handler ends in `_` and is unavailable through `google.script.run`.
- Google Workspace domain-restricted web app.
- Server-observed Google Workspace email must match the FLINK account email.
- First-run root creation is owner-bound: **FLINK Time → Prepare Installation** records the Master Sheet owner, then Setup Step 1 requires both the active Google identity and the execute-as-deployer identity to match that prepared owner.
- Normal installation does not use or expose a one-time setup key. Legacy setup-key properties are deleted after successful root creation if they exist.
- Password hashing, failed-login throttling/lockout, session idle/absolute expiry, password-version invalidation, forced password change, and MFA rules remain in `Code.gs`.
- Password hashes use explicit v2 framing for new/reset credentials while retaining v1 verification for migration. PBKDF2 iteration cost is calibratable from Super Admin System Health against a ~700 ms target. The configured `PBKDF2_ITERATIONS` value has a hard server floor of 10,000 and ceiling of 1,000,000; successful password verification upgrades older hashes in place without changing the user's password or rotating `PasswordVersion`.
- TOTP storage supports Google Cloud KMS ciphertext (`kms$v1$`) bound to `FLINK_TOTP_V1|<UserID>` authenticated data. `DUAL_READ` supports controlled migration from legacy `enc$v1$`; `KMS_REQUIRED` fails closed on legacy/unversioned secrets, and KMS failures never fall back to legacy decryption.
- High-risk Super Admin mutations require a short-lived step-up grant created only after fresh password + TOTP verification. Step-up rotates the authenticated session and is bound to the replacement SessionID.
- WP2 requires authenticator enrollment for every account, including initial owner setup. A password-only session has `AuthLevel=MFA_ENROLLMENT`, expires within ten minutes and can only use the restricted authentication actions; application/setup configuration actions remain blocked. Successful confirmation rotates it to an `MFA` session. Legacy sessions without assurance must sign in again.
- `MFA_REQUIRED` is mandatory, returned as enabled/read-only even if legacy settings store false; disabling MFA is rejected server-side. Enrollment sessions remain in browser memory. Setup uses a manual authenticator key without an external QR service.
- Enrollment checks durable session revocation/expiry, account identity/status, password generation and session epoch both before verification and inside the writer lock, preserves durable failure counters, consumes the confirmed TOTP timestep and requires redacted audit intent/completion. Confirmation rejects malformed deadlines. Login challenges are generation-bound.
- Session creation rechecks the durable ACTIVE account and identity inside the session writer lock. Rotation preserves MFA assurance (including step-up and password changes). If a cached account generation disagrees with a replacement session, validation refreshes the durable account so failed eviction cannot break completed enrollment.
- Existing installations have an owner-only, browser-inaccessible editor migration: `migrateSessionAssuranceSchema_()`. It accepts only the known current/previous Sessions headers, appends `AuthLevel` with flushed audit intent/completion, and never backfills assurance into old sessions. Retrying verifies the current header and records completion after an interrupted migration. New installations bootstrap the full schema.
- Combined offline results and the migration runbook are in `SECURITY_FOUNDATIONS_INTEGRATION.md`. Initial KMS provisioning, recovery and live Google verification remain deployment gates.
- Step-up performs password/TOTP computation before acquiring ScriptLock, then discards request-local security table snapshots and rechecks durable account identity, ACTIVE/SUPER_ADMIN state, credentials, lockout, account/session epochs, session revocation/expiry and the TOTP replay counter inside the lock. A code that aged outside the accepted timestep window while waiting is rejected. Grant expiry is a finite integer deadline and is exclusive.
- Step-up flushes a redacted, correlated Before/After intent before mutation. It consumes the timestep, rotates the session/grant, requires a completion audit, and flushes before returning either bearer token. Failure attempts grant deletion, replacement revocation and a cleanup flush while still locked. A timeout/crash can leave a consumed timestep or an undelivered session; Sheets and Properties are not a transaction. Sign-in/retry and expired-record cleanup remain necessary.
- The sole root SUPER_ADMIN is a protected trust anchor: generic CRUD cannot demote it, deactivate it, re-bind its Google Workspace identity, or disable its MFA.

## Privileged storage boundary
- The Master Control Sheet, workspace Sheets, backup files, and Apps Script project are privileged infrastructure.
- Ordinary users must not receive direct Editor access to those resources; direct edit access bypasses application RBAC.
- Production should use a dedicated deployment/automation identity where possible.
- Admin and Super Admin portals are direct Web App pages and are not framed with ALLOWALL.

## Data integrity
- UTC storage.
- Workspace-local timezone/date/week interpretation.
- One active timer per user.
- Idempotent timer operations.
- Optimistic concurrency for time-entry mutation.
- Immutable timesheet submission membership.
- Explicit timesheet state machine.
- Canonical rollup rebuild from raw TimeEntries.
- Audit records are spreadsheet-canonicalized before HMAC calculation.
- Daily external checkpoints anchor the Master and each active workspace audit chain in Script Properties.
- Checkpoints include a full-prefix snapshot HMAC so legacy audit fields become sealed against later mutation.
- Privileged mutations require a successful pre-action audit write; if the security audit trail is unavailable, the mutation is blocked.
- Workspace restore records and flushes a correlated `RESTORE_INTENT` with the original, candidate, source-backup and safety-backup identifiers before changing workspace status/pointer. Completion audit and final ACTIVE writes must flush before success is returned.
- Restore failures treat attempted writes as potentially applied. Candidate cleanup requires either no pointer-switch attempt or a flushed, fresh read confirming the prior ACTIVE pointer. Unconfirmed rollback preserves the candidate, attempts MAINTENANCE containment, and returns `recoveryRequired: true`; it never claims successful rollback. Cleanup itself requires an audited intent. See `RESTORE_RECOVERY_VERIFICATION.md` for interruption and owner-recovery limits.

## Installation and repository policy

FLINK Time has two distribution paths.

### Automated installer

The preferred normal-user path is a separate standalone Apps Script installer. It runs as the user accessing it and has its own script-management scopes. Those broader scopes are not present in the five-file FLINK Time runtime.

The installer uses the official Apps Script API to create a bound project, upload the five production files from an immutable pinned release, create a version, create the Web App deployment, and return the deployment URL. It injects only the dedicated Master Sheet ID and installation-owner bootstrap sentinels.

API-installed copies have a first-run self-authorization gate. Before serving the normal portal, the gate activates only while an injected installation owner exists and durable installation-owner state is still absent. It verifies the signed-in owner and uses `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL)` to show Google's authorization URL if required. No production OAuth scope is added for this gate.

### Manual/template fallback

1. copy the Master Sheet in My Drive;
2. choose **FLINK Time → Prepare Installation**;
3. deploy the Web App as **Me** to the Google Workspace domain;
4. choose **FLINK Time → Open FLINK Time**;
5. open Super Admin and complete the GUI wizard.

The active source remains source-first. Compiled executables, temporary packaging output, legacy desktop clients, and duplicate Apps Script modules are not committed.

## Settings catalog and feature flags (WP5)

- `SETTINGS_CATALOG` is the single schema for configurable global/workspace settings: key, group, label, type, default, limits/options, scope, step-up requirement, and help text.
- Super Admin uses `settings.getCatalog` and step-up-protected `settings.patch`; the Settings GUI is generated from the catalog rather than hard-coded fields.
- Global values live in `GlobalSettings`; workspace values live in each workspace's `WorkspaceSettings`.
- `Flags` performs one cached global `FLAGS` read per request (with durable Sheet fallback) and caches workspace flags per request. Patches invalidate the cache.
- Server-side feature guards are authoritative. Report export and live view already reject requests with `FEATURE_DISABLED` when their workspace flag is off; later work packages attach the remaining planned flags to their features.
- Session idle/absolute timeout settings are sourced from `SESSION_IDLE_MINUTES` and `SESSION_MAX_HOURS`, with existing hard-coded limits retained as fail-safe fallbacks.
- `PBKDF2_ITERATIONS` remains bounded server-side to 10,000–1,000,000 and is compatible with WP1 upgrade-on-login.
- `FEATURE_TIMESHEET_APPROVAL` defaults to false in preparation for WP3; WP3 attaches the approval actions/UI to that flag.

## Request-cost hardening (WP1 in progress)

Authenticated request paths no longer require whole-table scans for session token, account ID/username, credentials, or workspace-ID lookups. These hot-path reads use bounded TextFinder column searches followed by a single-row read.

Session validation uses a 60-second `S:v2:<tokenHash>` ScriptCache entry. The
versioned namespace ignores older five-minute entries during rollout. Cache is
an accelerator only: misses, eviction and backend failure fall back to durable
Sheets. Durable session updates invalidate the cached token; failed eviction is
bounded by the one-minute TTL, not an immediate-revocation guarantee.
Session and user-bundle caches include an application-checked deadline measured
from the start of the durable read. Delayed writes cannot renew stale snapshots;
the local fallback enforces that deadline too. Older user bundles are ignored by
the `U:v2:<userId>` namespace. This bounds cache reuse, not already-running requests.

Session touches and revocations use a ScriptLock, resolve the current row inside
the lock and return the durable updated record rather than recaching a stale
snapshot. A touch rechecks revocation, identity, epoch and expiry before writing.
Housekeeping takes that same lock around its session snapshot and batch deletes
so row shifts cannot redirect a session writer. The lock is released before
other cleanup and job logging; acquisition waits at most one second. Flush
failures propagate while still releasing the lock. The maintenance phase still
scans session/account tables; its lock duration must be measured on Google and
chunked if necessary before wider rollout.

Exact master-key lookups use literal, whole-cell TextFinder matching and inspect
at most two matches to reject duplicate keys. Explicit malformed expiry/epoch
values fail closed; only absent legacy epoch values default to one.
The key is rechecked against the transferred row so a concurrent purge cannot
cause a key lookup to return somebody else's record; detected shifts fail with
a retryable storage-busy error.

WP1 now also uses account/session epochs for constant-cost revoke-all: a session records the account epoch at creation, and security-sensitive account lifecycle operations invalidate existing sessions by rotating the account epoch instead of scanning the Sessions tab. Housekeeping later marks those stale rows revoked and purges them after seven days in contiguous batches.

Master/workspace schema repair also safely trims unused allocated rows/columns. It never automatically deletes populated columns beyond the known schema.

WP1 now has all-method Spreadsheet boundary instrumentation, including metadata
and finder methods. At both 10 and 50,000 mocked rows, session validation takes
41 boundary method calls cold, zero warm, and 63 with an activity touch (one
batched write). These are regression proxies, not Google's quota consumption or
the originally proposed six-call acceptance target. Real-deployment timing,
complete timer/weekly-list budgets and bounded TimeEntries range reads remain;
the growing entry scans require the later data-book/query work.
