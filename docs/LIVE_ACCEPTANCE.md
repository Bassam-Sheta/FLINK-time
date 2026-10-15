# Live acceptance handoff

## Staging checkpoint — 2026-10-15

The approved owner-only Version 2 Web App still contains baseline `1be2712`.
The existing synthetic Master, private owner-only sharing, exact binding and
COMPLETE preparation checkpoint were verified through the audited connection;
the root account already exists and must not be recreated. Keep archived
properties and original/other resources uninspected.

Supported password recovery completed with independently verified reset audits
and credential/session generation changes. The temporary email-recovery setting
is off, its cleanup checkpoint is CLOSED and the temporary remote helper was
removed. Do not request another reset email or edit credential cells. Successful
correct-password sign-in and mandatory authenticator completion are still
unverified. Login/enrollment/recovery-code screens may remain sensitive: require
explicit owner confirmation that they are closed before any portal capture.

Later entry-audit recovery and the local password-performance/QR patch have not
been uploaded or deployed. The new QR is therefore not yet available in that
staging version. See [local performance and QR evidence](PERFORMANCE_MFA_QR.md).
Use a reviewed matched-source upload and fresh saved-source verification before
changing that deployment; never weaken the old source transport's revision pin.

REST `doctor` still reports missing configuration and makes no Google calls;
browser consent does not supply REST credentials or production-exclusion metadata.
Continue on the existing synthetic installation. The owner signs in and completes
mandatory authenticator setup locally, without snapshots of passwords, seeds or
recovery codes. Exact approved resource IDs and saved-source evidence remain in
machine-local staging records. Mailbox/KMS scenarios still require separate
approval. Production and installer release pins remain unchanged.

## Acceptance gates

Run `npm run staging -- doctor` for the current local blockers. The owner supplies
the approved disposable target/configuration, completes interactive Google consent,
and authorizes staging upload/execution using `docs/STAGING_TESTS.md`.

The runtime-primitives diagnostic project must remain empty of application storage.
Use a separate synthetic application installation for the scenarios below. Record
the tested Git SHA, deployment version, execution mode, scenario, pass/fail and
redacted evidence. Never record raw codes, passwords or bearer tokens.

| Scenario | Acceptance evidence | Current status |
| --- | --- | --- |
| Google identity | Correct identity succeeds; missing/wrong identity and cross-workspace access fail | Root/binding verified; sign-in and denial cases pending |
| MFA | Enrollment required for every role; recovery session cannot access app actions | Pending |
| Recovery | Single-use codes, lockout, replacement, email delivery and password reset retaining MFA | One approved password reset verified; other scenarios pending |
| Timer | Stop saves OPEN entry; project switch retains entire interval; stopped edits leave running timer intact | Pending |
| Concurrent writers | Two clients racing stop/project change/recovery produce one attributable durable outcome | Pending |
| KMS | Approved key/IAM works; denied access fails closed; ciphertext is user-bound | Pending provisioning |
| Storage rotation | Separate Data file below 70% allocation; historical edits/retries and reports remain correct | Implemented in draft; live test pending |
| Failure recovery | Interrupted audit/write/flush produces recoverable state, never false success | Pending |

Google Sites embedding is tested only for the supported employee surface. Admin
and Super Admin use direct URLs under the current policy. No production rollout is
implied by a passing diagnostic or by this handoff document.
