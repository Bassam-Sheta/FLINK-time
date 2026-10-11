# Timer correctness — 2026-10-11

Branch `wp7-timer-correctness`, baseline `edbb993` (published MFA recovery).

- Stop already saves an unlocked OPEN entry independently of approval; the new regression asserts its status, empty timesheet membership and full original interval.
- Added authenticated, workspace-authorized `timer.changeProject`: same timer and start timestamp, new project, cleared task, no split entry. Current timer/project checks serialize with stop and other project changes. Intent/completion audits must flush; audit failures block writes and uncertain results require refreshing the durable timer.
- Stopped-entry edits remain isolated to their entry. A regression makes every active-timer repository operation throw if touched during the edit.
- All three portals persist project changes and recover durable state after failures. Continuing a recent task aborts when stopping the current timer did not succeed.

Verification: **532 unit tests passed**, **14 existing mocked Chromium tests passed**, native npm audit **zero findings**. The existing browser suite does not specifically exercise the new project-change RPC; its semantics are covered by service tests. Live Google concurrency and deployment validation remain pending.

Existing stop rollback/rollup behavior and broader recoverable audit work remain follow-up concerns documented in the security review. No schema migration is required for this package.
