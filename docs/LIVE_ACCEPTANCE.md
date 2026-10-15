# Live acceptance handoff

## Staging checkpoint — 2026-10-15

The approved owner-only Version 2 Web App contains baseline `1be2712` and previously
rendered the Super Admin first-run screen. This is rendering evidence only, not
completed setup/MFA, privacy, identity, authorization or data acceptance. Later
local recovery changes have not been uploaded or deployed.

The audited main-profile Chrome connection is currently unavailable. The owner
must enable Chrome remote debugging and approve its connection prompt locally.
Do not reconnect through an unrestricted transport or inspect credential screens.
REST `doctor` still reports missing configuration and makes no Google calls;
browser consent does not supply REST credentials or production-exclusion metadata.

After reconnecting, resume the existing synthetic installation, not another create:
verify only its private sharing, Master binding and completed staging preparation
checkpoint. Keep archived properties and the original Master uninspected. The
owner then creates the root account and completes mandatory authenticator setup
locally, without snapshots of passwords, seeds or recovery codes. Exact approved
resource IDs and saved-source evidence remain in machine-local staging records.
Mailbox/KMS scenarios still require separate approval. Production and installer
release pins remain unchanged.

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
| Google identity | Correct identity succeeds; missing/wrong identity and cross-workspace access fail | Pending owner setup |
| MFA | Enrollment required for every role; recovery session cannot access app actions | Pending |
| Recovery | Single-use codes, lockout, replacement, email delivery and password reset retaining MFA | Pending |
| Timer | Stop saves OPEN entry; project switch retains entire interval; stopped edits leave running timer intact | Pending |
| Concurrent writers | Two clients racing stop/project change/recovery produce one attributable durable outcome | Pending |
| KMS | Approved key/IAM works; denied access fails closed; ciphertext is user-bound | Pending provisioning |
| Storage rotation | Separate Data file below 70% allocation; historical edits/retries and reports remain correct | Pending implementation and live test |
| Failure recovery | Interrupted audit/write/flush produces recoverable state, never false success | Pending |

Google Sites embedding is tested only for the supported employee surface. Admin
and Super Admin use direct URLs under the current policy. No production rollout is
implied by a passing diagnostic or by this handoff document.
