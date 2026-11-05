# Open questions from the implementer

Newest first. Each entry: date, ticket, the question, what is blocked. The owner answers inline and marks it **Answered**.

## 2026-11-05 · T0.1 / T0.2 · Phase 0 has not been run — is building ahead of the gate accepted?

PLAN section 14 says building starts only when the Phase 0 tests pass or their fallback is accepted, and tests 2, 3, 7, 11 and 14 decide the architecture. `phase0-results.md` is still empty. The owner told the implementer on 2026-11-05 to start on the app, so work began with Phase 1 tickets that do not depend on those results (T1.1 scaffolding first). Phase 0 itself needs a real Turso database, a real Apps Script project and a real employee Google account, which the implementer cannot create.

- **Not blocked yet:** T1.1 to T1.3, T1.5 to T1.7 (scaffold, `fake-turso.js`, migration, utilities, validation, config).
- **Provisional until Phase 0 is recorded:** anything that encodes a Turso behaviour as fact: the conditional-batch rollback and plain-pipeline behaviour in `fake-turso.js` (test 2), the `_assert` pattern (test 3), the response shape in `Db.gs` (test 4), `REFERENCES` enforcement (test 5), and the no-lock write design (test 11).
- **Needed from the owner:** run T0.1 and T0.2 and fill in `phase0-results.md`, or confirm in writing that Phase 1 may continue before the gate. If test 11 fails, the write path falls back to the script-lock design (PLAN section 6) and `Db.gs` changes.

**Open.**

## 2026-11-05 · T1.1 · `npm run test:v2` as written in BUILD_SPEC section 2.2 does not work on Node 24

The spec says `"test:v2": "node --test tests/v2/"`. On Node 24.22.1 that fails with `Cannot find module '...\tests\v2'`: a directory argument is read as a file path. The implementer applied the smallest change that keeps the spec's intent (run every v2 test file, never the helpers): `"test:v2": "node --test \"tests/v2/**/*.test.js\""`. No other behaviour changed. BUILD_SPEC section 2.2 should be corrected to match.

**Answered by implementer's fix; owner to confirm.**
