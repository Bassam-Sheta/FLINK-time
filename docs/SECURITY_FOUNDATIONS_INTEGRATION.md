# Security foundations integration — 2026-10-07

Branch: `integrate-security-foundations`, based on `origin/main` at `bf29b6b`.
This work package combines the five published packages into one reviewable snapshot:

| Package | Source commit |
| --- | --- |
| Runtime/staging verification | `cfc806a` |
| Session boundaries | `4bd19bd` |
| Mandatory MFA | `853cdc0` |
| Privileged step-up | `9c25387` |
| Restore failure recovery | `94d6414` |

The per-package verification reports describe their original branches. Results
below apply to the actual combined code, including integration corrections.

## Integration corrections

- Retained negative-token caching and browser `safeStorage`, while enforcing
  sixty-second snapshot deadlines and fresh literal, duplicate-rejecting durable
  authorization lookups. The old table-cache reuse assertion was replaced with a
  stale-account regression using the bounded Sheets adapter.
- Step-up's replacement session explicitly carries `MFA` assurance.
- Session issuance now acquires/reuses the writer lock and reads the durable
  ACTIVE account/identity. Failed cache eviction during MFA rotation previously
  issued a replacement with the old epoch; a failing combined regression caught
  this. Validation refreshes account bundles when the session generation differs.
- Enrollment and confirmation recheck the durable session under the writer lock.
  Regressions reproduced revoked/expired requests installing pending keys, invalid
  enrollment deadlines being accepted, and corrupt epochs being treated as one.
- Updated older service fixtures for the locked repository/MFA contracts. The
  browser login-code locator now exactly matches its label to distinguish it from
  the new enrollment-code field.
- Added an owner-only additive session-header migration with verified retry after
  failed flush or completion audit. It preserves all existing data rows.

## Offline verification

- Frozen install: `npm ci --ignore-scripts --no-audit --no-fund` succeeded.
- Unit suite: **494/494 pass** (`node --test tests/*.test.js`). Includes fifteen
  new cross-package/migration cases, original restore regressions, and mocked
  bounded session reads at 10 and 50,000 rows.
- Configured browser suite: **9/9 mocked Chromium tests pass**
  (`npm run test:browser`), including owner setup pausing for MFA and continuing
  to company configuration only after confirmation.
- Combined regressions exercise real session/repository code for enrollment,
  step-up, password rotation, stale cache generations and revocation; Sheets,
  locks, clock, identity and cryptography are synthetic adapters.
- `npm audit --audit-level=high --ignore-scripts` still fails with three high
  entries from the single `braces` advisory through developer-only clasp.
  `DEPENDENCY_REVIEW.md` records reachability, mitigation and the next review date.
  The native CI audit gate remains enabled.
- These checks do not measure live Google latency, quotas, concurrency or KMS.

## Existing-installation migration runbook

Validate on an owner-approved synthetic staging copy before production rollout.

1. Verify the prepared installation owner/deployer identity and KMS configuration.
   Current encryption modes remain unchanged: an unset `FLINK_KMS_MODE` selects
   legacy encryption; `DUAL_READ`/`KMS_REQUIRED` require separately provisioned
   KMS key resource, IAM and OAuth access. Mandatory MFA does not provision KMS.
2. From the bound project's editor, that owner runs
   `migrateSessionAssuranceSchema_()`. It checks active and effective Google
   identities, serializes with session writers, validates the complete header,
   allocates a column if needed and writes only the `AuthLevel` header.
3. Verify `SESSION_ASSURANCE_SCHEMA_COMPLETED` in GlobalAudit. If the operation
   reports failure/interruption, retry the same helper: it verifies the header
   and records completion without adding another column. Unexpected/reordered
   columns are rejected for manual review.
4. Existing blank-assurance sessions must sign in again. MFA-enabled accounts
   verify their authenticator; other accounts receive a restricted ten-minute
   enrollment session. No legacy token is upgraded by the migration.
5. New installations already bootstrap this column. The first owner receives an
   enrollment-only `SETUP_WIZARD` session; company setup stays gated until MFA
   confirmation rotates it. Live owner/KMS behavior still requires staging checks.

The helper changes no user role, identity, secret or session row. Audit and header
writes are not transactional; retries provide verified completion, not rollback.

## Remaining gates and work packages

- Approved Google staging configuration/OAuth, KMS provisioning, privileged Sites
  embedding and retention decisions; live identity, concurrency and restore tests.
- Authenticator recovery codes and email password recovery without an MFA bypass;
  further challenge issuance/race and authentication interruption recovery work.
- Timer/project semantics, real yearly Data-file rotation, bounded growing-table
  requests/jobs, granular manager grants and broader attributable audit recovery.
- Restore may still require manual containment after runtime termination skips
  catch/finally. Preserve referenced candidates; see `RESTORE_RECOVERY_VERIFICATION.md`.
- Installer release pin still references its prior source. No production deployment
  or live migration was performed for this integration.
