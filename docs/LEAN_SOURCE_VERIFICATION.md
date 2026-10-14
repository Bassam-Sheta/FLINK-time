# Lean-source passes (WP11)

Based on merged `main` at `cc39199a186151d22ad47b60a3e762658bc6bfe7`,
not the unmerged yearly-routing draft #26. That package is preserved separately.

## Source reduction

Physical lines, including comments/blanks; no minification or comment deletion:

| Production file | Before | After |
| --- | ---: | ---: |
| Code.gs | 17,549 | 17,387 |
| User.html | 5,045 | 5,045 |
| Admin.html | 4,937 | 1,113 |
| SuperAdmin.html | 5,046 | 1,624 |
| appsscript.json | 20 | 20 |
| Total | 32,597 | 25,189 |

Portal source falls from 15,028 to 7,782 lines (48.2%). Most of this is real
duplicate source removal, not feature removal or compacted formatting. Shared
CSS and identical function chunks now live once in User.html. Differing role
functions, state initialization, navigation, markup and setup code stay separate.
Backend primitives centralize header caching, formula-safe row serialization
and adjacent-column writes. The renderer itself adds a small amount of backend
code; the backend line reduction is deliberately modest.

The follow-up removes another 134 backend lines (3,840 bytes) by replacing
duplicate daily/weekly/monthly incremental writers with one period writer.
It preserves strict period/user/project matching, weekly end-date refresh,
per-entry integer-cent rounding, counts, timestamps and existing write order.
Full rebuild now takes one last-row snapshot per tab, avoiding four repeated
metadata calls when all four rollup tables contain rows. Existing rollup tests
also check fractional cents, repeated buckets and exact deletion boundaries.

Summary reports load only the name tables used by selected groupings: default
project/user skips Tasks; date/billable/tag and empty results load none. Workspace
authorization, forced USER self-scope and financial DTO whitelists remain intact.
Null-prototype name maps/buckets fix reproduced crashes and incorrect names for
prototype-shaped labels/IDs such as `__proto__` and `constructor`. These are
lookup/metadata reductions, not a bounded growing-entry query implementation.

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
- Default application suite: **507 passed**, no skips/failures. The two duplicate
  header-cache tests are consolidated into one table-driven test for both
  repositories, adding exact write shapes, formula defense and protected gaps.
- Browser suite: **14 mocked Chromium tests passed**. It exercises enrollment,
  recovery, unsafe markup, employee workday and role/setup screens.
- The disconnected storage experiment was first separated and its **48 optional
  checks passed**, then its ten files and optional command were removed at the
  owner's request. They are not application coverage. Research source remains
  recoverable at commit `d34e55051649b6cdbe314b0a26dbf064ffa277e4`; no application
  tests or required production files were deleted. Historical security reviews
  describe the old prototype paths, not a supported current implementation.
- `git diff --check` passes. No dependency, OAuth scope, installer pin, production
  setting or live data is changed. Synthetic fault-injection tests still emit
  expected audit/flush/maintenance diagnostics; those are not live Google logs.

Before release, approved staging must verify real HtmlService expansion on all
three views, privileged framing, owner setup, MFA/recovery and a timer workday.
Use the existing STAGING_TESTS.md/LIVE_ACCEPTANCE.md authorization boundary; this
package does not authorize upload, live execution or production deployment.
