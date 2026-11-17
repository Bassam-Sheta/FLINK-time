# Open questions from the implementer

Newest first. Each entry: date, ticket, the question, what is blocked. The owner answers inline and marks it **Answered**.

## 2026-11-05 · T1.11 · The owner check in BUILD_SPEC section 8 would pass for every employee

Section 8 says each owner function checks `Session.getEffectiveUser().getEmail() === OWNER_EMAIL`. The web app is deployed with `executeAs: USER_DEPLOYING` (section 8, manifest), and Apps Script documents that for such a web app `getEffectiveUser()` is the deploying user, so it is the owner for **every** visitor. Every top-level function without a trailing underscore can be called from the page with `google.script.run`. Taken together, any employee could call `ownerGrantSuperAdmin('me@company.com')` from the browser console and pass the check. This is from Apps Script's documented behaviour; it has not been confirmed on this deployment, and Phase 0 test 7 is the place to confirm it.

Proposed fix, for the owner to approve: the owner functions compare `Session.getActiveUser().getEmail()` (the person actually running or visiting) with `OWNER_EMAIL`, and also require `getEffectiveUser()` to match; a test sets effective = owner and active = someone else and expects a refusal. In the editor both emails are the owner's, so the owner still passes. Section 8 and the T1.11 ticket should say so.

**Blocks T1.11 only.** Until then there is no public `runMigrations`, `installTriggers` or other owner function (a test pins this for `runMigrations`). **Open.**

## 2026-11-17 · T1.6 · Two actions have a payload field the schema grammar cannot describe

Section 6.1 lists the schema types. Two fields in section 6.2 have a type that depends on another field, and none of the listed types fits:

- `settings.patch`: `{scope, key, value}`. `value` is text, a number or a bool depending on `key` (the settings catalog, section 6.5).
- `entries.bulk`: `{ids, op, value?}`. `value` is a project id, a bool, or a list of tag ids depending on `op`.

Proposal: one extra schema type, `any`, which accepts only a JSON scalar (text of at most 500 characters under the same character rules as `text`, a finite number, a bool) or a list of at most 50 ids, and nothing nested. The handler then validates the value against the catalog entry or the operation, as the spec already describes. Section 6.1 would gain one line. Nothing is built for it yet, so no behaviour changes if you prefer a different answer (for example one schema per `op`).

**Blocks the schemas of those two actions in T1.8 / T2.5 only.** **Open.**

## 2026-11-17 · T1.6 · Noted, no answer needed: how the schema checker fills the gaps in section 6.1

Each of these is pinned by a test in `tests/v2/validate.test.js`; say if any should change.

- **Optional means absent or null.** A field with `?` may be missing (left out of the result: "leave unchanged") or `null` (kept as `null`: "clear it"). Section 6.2 needs the second reading, for example `users.setAdminLimit` takes "`int:0:50` or `null` for the default" and `entries.update` must be able to remove a project. A required field may be neither.
- **Order of complaints.** Unknown fields are reported first (so a mass-assignment probe stops there), then the schema's fields in the order the schema lists them. `__proto__`, `constructor` and similar names are just unknown fields.
- **Text length counts characters, not UTF-16 units**, because the database `CHECK`s use SQLite `length()`. 120 emoji fit a 120-character name.
- **Tab and newline are allowed only in text whose maximum is 500 or more** (descriptions, notes, reasons); names and shorter text allow neither. The spec says "except tab and newline in notes and descriptions" but the schema type does not say which fields those are; the limits (500 and 2,000 against 120 and 60) do.
- **Always refused in text:** other control characters (including carriage return and the C1 range), U+2028/U+2029, and lone surrogates. The last two go beyond the spec: they would otherwise reach the database and the exports as invisible line breaks or broken characters.
- **`id` is lower-case only** (no case folding, so an id can never match two different rows); **`code` is not upper-cased for you** (`abc` is refused); **`email`** is trimmed, lower-cased and must be ASCII with a dotted domain and a letter-only last label (internationalised addresses are refused; the database also requires lower-case).
- **`ms`** allows 10 years of 365.25 days either side of the server clock, ends included. **`cursor`** is passed through untouched (no trim), 1 to 200 characters, no control characters.
- **Formula neutraliser:** copied from `Validation.sanitizeCellValue` and `ExportService.escapeCsv`. Same rule (apostrophe in front of a string that starts, after spaces, with `= + - @` tab CR LF, except plain numbers). Three differences: the 50,000-character cap is applied after the apostrophe so a cell never exceeds the Sheets limit, a cut never leaves half a surrogate pair, and a `NaN`, object or date is refused instead of being turned into text.
- **A source-file quirk worth knowing:** an escape typed as ` ` or ` ` in a file-writing tool call was turned into the real character, which ends a line in JavaScript and broke a regex. The files are fixed and a test now fails if either character appears literally in `apps-script-v2/` or `tests/v2/`.

## 2026-11-17 · T1.5 · Please run a 30-second check in the Apps Script editor (time zones)

`Util.gs` computes every `local_date` with `Utilities.formatDate`. The tests use the fake, whose time zone data is Node's (which has Egypt's 2023 DST rules). Two things about **real** Apps Script are not recorded in `phase0-results.md`, and the spec says not to assume them. Run this once in any Apps Script project and paste the output here or into `phase0-results.md` (it fits Phase 0 test 7's session):

```js
function checkTimeZones() {
  const f = (iso, tz) => Utilities.formatDate(new Date(iso), tz, "yyyy-MM-dd HH:mm:ss Z");
  ['2026-04-23T21:59:59Z', '2026-04-23T22:00:00Z', '2026-10-29T20:59:59Z', '2026-10-29T21:00:00Z', '2026-10-29T22:00:00Z']
    .forEach(iso => console.log(iso, f(iso, 'Africa/Cairo')));
  ['Mars/Base', 'africa/cairo'].forEach(tz => {
    try { console.log(tz, '->', f('2026-07-01T12:00:00Z', tz)); } catch (e) { console.log(tz, 'throws:', e.message); }
  });
}
```

Expected if Apps Script knows Egypt's rules: `2026-04-23 23:59:59 +0200`, `2026-04-24 01:00:00 +0300`, `2026-10-29 23:59:59 +0300`, `2026-10-29 23:00:00 +0200`, `2026-10-30 00:00:00 +0200`. For the other two zone ids it either throws or quietly formats as GMT; both are fine, because `Util.isValidTimeZone_` cross-checks `formatDate` against `Intl` and rejects an id the two disagree about. If the Cairo lines differ, the DST handling of `local_date` is wrong on the real platform and needs a decision before T2.4. **Open.**

## 2026-11-17 · T1.5 · Noted, no answer needed: choices where the spec is silent

- **`Util.clampClientTime_(clientAt, now, skewSeconds)`** takes the skew as an optional third argument (default 120) because the spec lists two. T1.7 and T1.8 must pass `TIMER_CLIENT_SKEW_SECONDS`. A `clientAt` that is not an integer time is not trusted at all (the server time is used).
- **`Util.hmacSha256Hex_(key, message)`** uses the spec's order, `HMAC_SHA256(key, message)`; Apps Script's own function takes `(value, key)`. Both strings are used as the UTF-8 text they are, so the 64-hex-digit audit key is not decoded.
- **Hashing never relies on a platform charset.** `Util.sha256Hex_` and `hmacSha256Hex_` turn strings into UTF-8 bytes themselves; a lone surrogate becomes U+FFFD (as in Node), so odd text in a description cannot make a request fail.
- **The report cache key** is `rep:{wsId}:{wsGen}.{repGen}:{digest}`. Section 5.4 says a report is invalidated by both `gen:ws:{wsId}` and `gen:rep:{wsId}` but shows one `{gen}`; the two numbers are joined so that bumping either changes the key.
- **A cache key over 250 characters is silently not cached** (CacheService would throw). Only an email of about 235 characters or more could reach that, and such a user would just be served uncached.
- **Date helpers** accept years 0001 to 9999; narrower ranges, if wanted, belong in `Validate.gs` (T1.6).
- `Migrations.gs` now hashes with `Util.sha256Hex_` (the T1.3 note asked for this); it keeps its own sender.

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
