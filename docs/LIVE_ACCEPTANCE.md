# Live acceptance handoff

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
