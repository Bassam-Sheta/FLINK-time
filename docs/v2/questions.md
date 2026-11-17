# Open questions from the implementer

Newest first. Each entry: date, ticket, the question, what is blocked. The owner answers inline and marks it **Answered**.

## 2026-11-05 · T1.11 · The owner check in BUILD_SPEC section 8 would pass for every employee

Section 8 says each owner function checks `Session.getEffectiveUser().getEmail() === OWNER_EMAIL`. The web app is deployed with `executeAs: USER_DEPLOYING` (section 8, manifest), and Apps Script documents that for such a web app `getEffectiveUser()` is the deploying user, so it is the owner for **every** visitor. Every top-level function without a trailing underscore can be called from the page with `google.script.run`. Taken together, any employee could call `ownerGrantSuperAdmin('me@company.com')` from the browser console and pass the check. This is from Apps Script's documented behaviour; it has not been confirmed on this deployment, and Phase 0 test 7 is the place to confirm it.

Proposed fix, for the owner to approve: the owner functions compare `Session.getActiveUser().getEmail()` (the person actually running or visiting) with `OWNER_EMAIL`, and also require `getEffectiveUser()` to match; a test sets effective = owner and active = someone else and expects a refusal. In the editor both emails are the owner's, so the owner still passes. Section 8 and the T1.11 ticket should say so.

**Blocks T1.11 only.** Until then there is no public `runMigrations`, `installTriggers` or other owner function (a test pins this for `runMigrations`). **Open.**

## 2026-11-17 · T1.4 · Noted, no answer needed: choices where the spec is silent

`Db.gs` follows section 5.3 branch for branch. These points are not in the spec, so the implementer chose and recorded them here; say if any should change.

- **A request-level error from Turso** (well-formed response whose first result is `{type:"error"}`) maps to `DB_UNAVAILABLE` (retryable), or `BUSY` if the message says the database is locked. Rationale: the outcome is not known, and the page retries with the same request id, which is safe. Phase 0 test 4 should record what real Turso sends.
- **A locked-database message beats `onError`.** If an `exec` step has `onError: CONFLICT` and the database says `SQLITE_BUSY`, the caller gets `BUSY`, not a false conflict.
- **Rate limit source.** `Db.tx_` reads `ctx.rateLimit` (default 60). T1.7 and T1.8 must pass the `RATE_LIMIT_WRITES_PER_MIN` setting there.
- **Usage counter.** Key `usage:{UTC yyyy-mm-dd}`, value `{"read":n,"written":n,"calls":n}`. CacheService keeps a value at most 6 hours, so the counter restarts after 6 idle hours; the hourly health job must copy it into `job_runs` before then, and the numbers are approximate by design. The spec does not say which time zone the "day" uses; UTC was chosen.
- **`INTERNAL` messages are generic** ("The database rejected a statement."); the SQL error text goes in `details.error` for the log, never in the message.
- **New spec-adjacent code in `Config.gs`:** `ERROR_CODES_` and `AppError_` (spec section 3 and 4.3), checked against the spec's own table by a test. T1.7 adds the settings catalog on top.

## 2026-11-05 · T1.3 · Noted, no answer needed: the migration runner carries its own sender and hasher

The runner cannot use `Db.tx_` (it writes to `request_log`, a table migration 001 creates), and `Util.gs` (T1.5) does not exist yet. `Migrations.gs` therefore has small private helpers `send_`, `arg_` and `sha256Hex_`.

- **Update 2026-11-17:** `Db.gs` now exists, but `Migrations.send_` stays on purpose for now. It talks to the owner in the editor ("run again to resume", "check TURSO_RW_TOKEN"), while `Db` reports app-facing `AppError_` codes, and the migration tests pin the owner wording. Revisit when T1.11 wraps `runMigrations()`; the wrapper can translate `Db` errors. T1.5 should still replace `sha256Hex_` with `Util`.
- The owner wrapper `runMigrations()` is left to T1.11 for the reason in the owner-check entry above.

## 2026-11-05 · T0.1 / T0.2 · Phase 0 has not been run — is building ahead of the gate accepted?

PLAN section 14 says building starts only when the Phase 0 tests pass or their fallback is accepted, and tests 2, 3, 7, 11 and 14 decide the architecture. `phase0-results.md` is still empty. The owner told the implementer on 2026-11-05 to start on the app, so work began with Phase 1 tickets that do not depend on those results (T1.1 scaffolding first). Phase 0 itself needs a real Turso database, a real Apps Script project and a real employee Google account, which the implementer cannot create.

- **Not blocked yet:** T1.1 to T1.3, T1.5 to T1.7 (scaffold, `fake-turso.js`, migration, utilities, validation, config).
- **Provisional until Phase 0 is recorded:** anything that encodes a Turso behaviour as fact: the conditional-batch rollback and plain-pipeline behaviour in `fake-turso.js` (test 2), the `_assert` pattern (test 3), the response shape in `Db.gs` (test 4), `REFERENCES` enforcement (test 5), and the no-lock write design (test 11). `fake-turso.js` leaves foreign keys **off** by default, so assert steps have to do the checking; if test 5 shows Turso enforces them, tests should also run with `createFakeTurso({ foreignKeys: true })`.
- **Needed from the owner:** run T0.1 and T0.2 and fill in `phase0-results.md`, or confirm in writing that Phase 1 may continue before the gate. If test 11 fails, the write path falls back to the script-lock design (PLAN section 6) and `Db.gs` changes.

**Open.**

## 2026-11-05 · T1.1 · `npm run test:v2` as written in BUILD_SPEC section 2.2 does not work on Node 24

The spec says `"test:v2": "node --test tests/v2/"`. On Node 24.22.1 that fails with `Cannot find module '...\tests\v2'`: a directory argument is read as a file path. The implementer applied the smallest change that keeps the spec's intent (run every v2 test file, never the helpers): `"test:v2": "node --test \"tests/v2/**/*.test.js\""`. No other behaviour changed. BUILD_SPEC section 2.2 should be corrected to match.

**Answered by implementer's fix; owner to confirm.**
