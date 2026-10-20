# Review defect fixes — 2026-10-20

Base: `898ae5bea82e8266d61a4a6ca0fc6ec628ace10d`.
Requirements: `../SYSTEM_SPEC.md`, `../LIVE_ACCEPTANCE.md`, owner review follow-up.

Keep the current three-file runtime, Google-only services, server authorization,
step-up, default MFA, explicit per-account exemptions and historical time/audits.
No production changes, dependency additions or installer-pin advancement.

1. Installer: test loading every file from the approved historical release contract
   in `tests/review-regressions.test.js`; correct `installer/Code.gs`'s file list,
   not its pin. Adjust `tests/automated-installer.test.js` to verify that contract.
2. Login: add lock-interleaving tests in `tests/mfa-exemption.test.js`; keep the
   fresh credential/policy decision and session creation inside one ScriptLock
   in `apps-script/Code.gs`. Check generation, identity and lockout freshness.
3. MFA policy/reset: test refused completion, failed flush, interruption and retry;
   retain a bounded, secret-free pending policy checkpoint until completion is
   durable. Reset clears timed lockout; preserve explicit exemptions and describe
   their actual enrollment outcome in the API and `apps-script/Portal.html`.
4. Deletion: test interruptions after terminal status, idempotent cleanup and
   original audit preservation in `tests/user-deletion.test.js`. Use the retained
   DELETED row as the cleanup checkpoint; retries never finalize time twice.
   Prevent accidental reactivation and expose cleanup retry in the Users GUI.
5. GUI: test all rendered role clocks and bulk requests. Fix the seconds scope;
   fetch bounded, authorized entry versions before confirmation and keep server
   optimistic concurrency checks. Cover real clicks in `tests/browser/`.
6. Verification: observe targeted regressions fail first, then run `npm test`,
   `npm run test:browser`, parse/library checks, npm audit and `git diff --check`.
   Record fresh local performance evidence separately from Google latency.

Staging: `doctor` currently reports missing configuration and no Google contact.
Only the existing exact owner-approved staging project may be modified; preserve
source and verify saved content before deployment. Owner handles login/consent/MFA
locally. Missing target exclusions, credentials, synthetic roles or consent block
live acceptance and end-to-end speed claims. Keep the installer pin unchanged
until matched-source live acceptance and comparable measurements pass.
