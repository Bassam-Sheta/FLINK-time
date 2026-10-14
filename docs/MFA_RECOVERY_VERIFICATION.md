# MFA and password recovery — 2026-10-07

Branch: `wp6-mfa-recovery`, based on `fix-staging-audit-dependency` at `2fef319`.
This package adds recovery within the five-file Google-only application.

## Security contract

| Action | Required proof | Result |
| --- | --- | --- |
| `auth.confirmMfa` | Current enrollment/recovery session, session-bound pending key and new TOTP | Full MFA session and eight backup codes, shown once |
| `auth.regenerateRecoveryCodes` | Full MFA session, fresh password and unused current TOTP | Eight replacement codes; previous generation invalid |
| `auth.recoverMfa` | Google account identity, password and unused backup code | Restricted ten-minute authenticator-replacement session |
| `auth.requestPasswordRecovery` | Google-bound ACTIVE account and enabled email setting | Generic response; eligible requests submit one email |
| `auth.completePasswordRecovery` | Same Google identity, enabled setting, unexpired generation-bound email code and valid new password | Password changed, sessions revoked, sign-in required; MFA retained |

The three new pre-session actions still enforce server-observed Google identity.
All mutations require POST. Recovery sessions permit only validation, enrollment,
confirmation and logout, including for Super Admin. Durable session assurance is
checked again before permitting replacement without the old authenticator.

Backup codes have 32 hexadecimal digits, formatted in eight groups of four.
The existing random helper supplies 32 bytes of input (two UUIDs in Apps Script);
SHA-256 truncation produces the 128-bit code without exposing fixed UUID bits.
Only domain-separated hashes are stored. Authenticator replacement rotates the
generation; password reset preserves backup codes so losing both factors remains
recoverable. A changed stored authenticator ciphertext invalidates its code binding.

Recovery state is one strictly validated `RecoveryJSON` cell, capped at 8,192
characters: eight or fewer backup hashes, one email reset record, three or fewer
mail timestamps, failure count and lockout deadline. Account/credential/session
lookups use the existing literal duplicate-rejecting row paths. Physical credential
headers are verified before reading or changing recovery state. GlobalAudit costs
remain part of the separate bounded-audit work package.

Five failed recovery verifications impose a fifteen-minute lockout. Password
login restarts, email requests and cache eviction do not clear it. Email issuance
has a one-minute cooldown and a three-per-rolling-hour allowance, persisted before
MailApp is called. Existing normal account lockout/status restrictions also apply.

## Interruption handling

- Intent/completion records contain actor, redacted Before/After summaries and
  operation identifiers. Raw codes, passwords, secret keys and bearer tokens are
  excluded. Completion/flush failure returns no new token or code.
- A backup code remains consumed after an uncertain write or later audit/session
  failure. Use another saved code, or sign in with the authenticator and regenerate.
- Reset flushes epoch revocation first, then password/token consumption, then
  clears `MustChangePassword`. A failed password write cannot release a temporary
  password from its forced-change state. If interrupted, try sign-in with the new
  password or request a fresh email code after the cooldown. Old-epoch reset codes
  remain invalid. Existing session-cache revocation has the foundation's bounded
  sixty-second stale-read window if eviction fails; recovery writers recheck the
  durable records inside their lock.
- Email submission happens outside ScriptLock, after audited issuance. A thrown
  MailApp call can mean uncertain delivery, so it retains the code and issuance
  allowance. A missing delivery/completion event requires owner review; no automatic
  resend, rollback or synthetic completion is claimed.
- Closing the browser loses undisplayed/unsaved raw codes. Full MFA plus fresh
  password/TOTP can generate a replacement set. The UI stores recovery-session
  tokens only in memory and removes the code display after acknowledgement.

## Existing-installation rollout

Validate first on an explicitly approved synthetic Google staging copy.

1. Apply the reviewed source and verify the installation owner/deployer and KMS
   configuration. Run `migrateSessionAssuranceSchema_()` if not already completed.
2. In the Apps Script editor, the prepared owner runs `migrateRecoverySchema_()`.
   It accepts only the known current/previous Credentials headers, appends the
   new header and preserves data rows. Verify `CREDENTIAL_RECOVERY_SCHEMA_COMPLETED`.
   Retry the same helper after interruption; unfamiliar headers require review.
   Do not rerun the full installation bootstrap on existing data.
3. Review and authorize the added
   `https://www.googleapis.com/auth/script.send_mail` scope. Explicit manifest
   scopes require consent even while the email feature is disabled. Recovery uses
   MailApp, with no Gmail inbox access or external mail provider.
4. Existing enrolled users sign in normally and generate backup codes from Account.
   Newly confirmed enrollments receive codes automatically. Save them privately,
   separate from the authenticator; acknowledgement clears the one-time display.
5. After owner-approved mail testing, a stepped-up Super Admin can enable
   `PASSWORD_RECOVERY_EMAIL`. Disabling it blocks further issuance and consumption;
   tokens are still subject to their original fifteen-minute expiry and generations.
6. Validate actual Google identity availability, mail delivery/quota behavior,
   simultaneous attempts, audit/flush interruption, enrollment and replacement
   across the three portals before authorizing a production deployment.

The private migration is not exposed through `google.script.run`. New installations
bootstrap the new column. An unset `FLINK_KMS_MODE` still selects legacy encryption;
this package does not provision KMS or change privileged embedding policy.

## Offline evidence

- Unit suite: **528/528 pass** (`node --test tests/*.test.js`). Real repository adapters cover code replay, competing writers,
  durable lockout, generation/identity/expiry/flag changes, TOTP replay, missing
  physical headers, failed audit/flush/mail calls and interrupted password writes.
- Mocked Chromium: **14/14 pass** (`npm run test:browser`). Flows cover recovery on all three portals, email reset returning
  to mandatory MFA, one-time acknowledgement and Account regeneration.
- Native `npm audit --json`: **zero findings**, 72 developer dependencies.
- Google identity, live concurrency, MailApp delivery, KMS and deployment validation
  remain pending. No Google deployment, migration or production release was run.

## Official API and quota references

Checked 2026-10-07:

- [MailApp](https://developers.google.com/apps-script/reference/mail/mail-app):
  `sendEmail(message)`, `getRemainingDailyQuota()` and the `script.send_mail` scope.
  Remaining quota counts recipients and is not a delivery guarantee.
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas):
  six-minute executions, 30 simultaneous executions per user and 1,000 per script;
  listed email-recipient quotas are 100/day for consumer accounts and 1,500/day for
  Workspace, with a separate within-domain allowance. Quotas can change. The runtime
  checks remaining mail quota and handles send uncertainty rather than assuming a
  fixed available allowance.
