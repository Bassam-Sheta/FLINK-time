# WP2 mandatory MFA — 2026-10-06

Branch: `wp2-mandatory-mfa`; base `9e6db78`.
This is an independent implementation branch requiring review/integration before
deployment. It does not contain the later GitHub milestones or WP1 cache fixes.

## Implemented

- `Sessions.AuthLevel` distinguishes ten-minute enrollment-only sessions from
  MFA-verified sessions; the central dispatcher denies app access before enrollment.
- Legacy sessions lacking assurance are rejected. First-run owner setup pauses for
  MFA before company configuration; all three portals support manual-key setup.
- Mandatory MFA is independent of feature settings. Catalog/UI show it enabled
  and read-only, even when a legacy stored flag is false; server disabling rejects.
- Enrollment rechecks durable account identity/state, password version and epoch.
  Failed attempts persist across restarts and eventually lock the account.
- Confirmation consumes the TOTP timestep, requires redacted audit records,
  activates encrypted pending credentials and rotates/revokes sessions.
- Login challenges bind password generation/epoch. Enrollment bearer tokens stay
  in browser memory; existing full-session transport remains sessionStorage.

## Offline evidence

- **285/285 unit tests pass**, including ten new mandatory-MFA behavioral cases.
- **7/7 configured mocked Chromium tests pass**, including employee, Admin and
  first-run owner enrollment flows. Existing browser navigation/test adapters were
  corrected to reflect the actual setup welcome page and session rotation.
- The catalog regression reproduced a stale stored false value and missing
  read-only metadata before correction.
- No new dependencies; reused the reviewed local Playwright installation.
- No live Google authentication, KMS enrollment, migration or deployment tested.

## Open integration gates

1. Migrate `Sessions.AuthLevel` and verify owner repair/setup can operate when old
   sessions are rejected. Provision and verify KMS before required enrollment.
2. Reconcile WP1 session-cache/locking changes and current-main authentication
   changes, including the independent step-up hardening branch.
3. Finish challenge issuance randomness/race review and strict validation; test
   interruptions between audit, credential, property and session writes.
4. Implement approved recovery codes and email password recovery without bypassing
   mandatory MFA. Recovery is not supplied by this branch.
5. Verify full combined request cost, live identities, concurrency and Sites behavior
   on owner-approved staging. Mocked flows do not prove these integrations.
