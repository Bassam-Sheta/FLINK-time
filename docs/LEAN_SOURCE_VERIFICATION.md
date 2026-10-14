# Lean-source first pass (WP11)

Based on merged `main` at `cc39199a186151d22ad47b60a3e762658bc6bfe7`,
not the unmerged yearly-routing draft #26. That package is preserved separately.

## Source reduction

Physical lines, including comments/blanks; no minification or comment deletion:

| Production file | Before | After |
| --- | ---: | ---: |
| Code.gs | 17,549 | 17,521 |
| User.html | 5,045 | 5,045 |
| Admin.html | 4,937 | 1,113 |
| SuperAdmin.html | 5,046 | 1,624 |
| appsscript.json | 20 | 20 |
| Total | 32,597 | 25,323 |

Portal source falls from 15,028 to 7,782 lines (48.2%). Most of this is real
duplicate source removal, not feature removal or compacted formatting. Shared
CSS and identical function chunks now live once in User.html. Differing role
functions, state initialization, navigation, markup and setup code stay separate.
Backend primitives centralize header caching, formula-safe row serialization
and adjacent-column writes. The renderer itself adds a small amount of backend
code; the backend line reduction is deliberately modest.

## Editing the five-file application

- `/* FLINK_SHARED:name */` in a role file refers to a trusted static chunk in
  User.html, expanded by private `renderPortalHtml_()` before HtmlService output.
- Shared chunks are the `<style>` body and top-level browser functions declared
  with four-space indentation. A function chunk extends to the next top-level
  declaration (including intervening comments). Keep that convention; do not
  insert similarly indented declarations inside template strings/nested bodies.
- Edit shared functions/styles in User.html. For a deliberate role-specific
  change, replace that role's marker with its complete expanded chunk and edit
  there. Shared code is not a security boundary: server permissions still decide.
- `node scripts/deduplicate-portals.js` optionally replaces newly identical
  chunks. It compares complete rendered output before writing either role file.
- `npm run test:browser` renders the same expanded pages, not raw fragment files.
- Ship all five runtime files together. Old Code.gs cannot render the new role
  fragments; rollback must also restore the complete matched five-file release.
- The automated installer pin remains unchanged. No deployed release is updated.

## Runtime cost and preserved requirements

The Master spreadsheet handle is reused within a request, reset on beginRequest
and reopened on an explicit file-ID change. Account/session/credential rows still
use fresh durable lookups as required. No new authorization cache is introduced.

At both 10 and 50,000 mocked rows, all-method session boundary counts are:

| Probe | Before | After | Master opens before/after |
| --- | ---: | ---: | ---: |
| Cold validation | 41 | 38 | 4 / 1 |
| Warm validation | 0 | 0 | 0 / 0 |
| Activity touch | 63 | 58 | 6 / 1 |

An independent before/after fixture comparison confirmed every non-open method
count is identical. No security reads, version checks, writer locks, audit events,
flushes or sanitization are removed. Patch writes still batch adjacent columns
only; unchanged cells are not overwritten.

SHA-256 characterization verifies all three expanded HTML pages against their
original complete source, including every byte of role-specific behavior.
Employee framing remains ALLOWALL; privileged framing remains DEFAULT. Unknown
paths, missing/duplicate chunks and inherited section names are rejected.
Rendering reads one fixed file for User and two for either privileged role, with
no Sheets reads, network assets, templates supplied by users or new browser RPCs.

**Not a claim of overall speed/scalability:** rendered browser bytes are unchanged;
Google timing is unmeasured. Growing-entry queries, reports, jobs and recoverable
yearly routing remain separate work. Mandatory MFA/KMS policy, roles, timer
semantics and audit requirements have not been relaxed to reduce source size.

## Test/tool separation and evidence

- Production remains exactly one backend, three portals and the manifest.
- Default application suite: **505 passed**, no skips/failures. The two duplicate
  header-cache tests are consolidated into one table-driven test for both
  repositories, adding exact write shapes, formula defense and protected gaps.
- Browser suite: **14 mocked Chromium tests passed**. It exercises enrollment,
  recovery, unsafe markup, employee workday and role/setup screens.
- Disconnected storage experiment plus all four tests and its exclusive fixture
  moved together to `prototypes/storage-v2/`. **48 optional prototype tests passed**
  with `npm run test:prototypes`; npm test/production CI no longer count them.
  Known prototype security weaknesses remain documented; nothing is deployed.
- `git diff --check` passes. No dependency, OAuth scope, installer pin, production
  setting or live data is changed. Synthetic fault-injection tests still emit
  expected audit/flush/maintenance diagnostics; those are not live Google logs.

Before release, approved staging must verify real HtmlService expansion on all
three views, privileged framing, owner setup, MFA/recovery and a timer workday.
Use the existing STAGING_TESTS.md/LIVE_ACCEPTANCE.md authorization boundary; this
package does not authorize upload, live execution or production deployment.
