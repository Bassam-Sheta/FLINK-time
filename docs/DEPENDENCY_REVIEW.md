# Developer dependency review — 2026-10-07

## Resolved by dependency removal

With owner approval, the staging wrapper now uses **google-auth-library 10.5.0**
and fixed Apps Script REST endpoints instead of clasp. The exact source allowlist,
hash checks, distinct-production-target guard and explicit mutation confirmation
remain. No glob patterns are parsed. New checks bind the OAuth client, verified
Google email and API deployment to the staging configuration. Authorization uses
a separately created authorized-user ADC file; see `STAGING_TESTS.md`.

- `npm ci --ignore-scripts --no-audit --no-fund`: clean frozen install succeeded.
- `npm audit --audit-level=high --ignore-scripts`: **0 vulnerabilities**.
- `npm audit signatures`: **72 verified registry signatures**, four attestations.
- Lockfile reduced from **298 to 72 packages**; **226 removed**, no new packages
  and no retained package version/integrity changes. Google auth was already
  present through clasp and is now a pinned direct developer dependency.
- No retained package declares an install lifecycle script. `.npmrc` continues
  to disable lifecycle scripts, and the CI native audit gate remains enabled.
- Synthetic regressions cover target/identity/deployment denials, credential
  validation/redaction, file projection, remote failures and successful evidence.
  Live Google authorization/upload/execution remains untested pending staging.
- **505 unit tests and 9 mocked Chromium tests pass** on the replacement graph.

Registry/advisory recheck still found no patched upstream `braces` version. The
vulnerable package and both dependency ancestors are absent from this lockfile;
the finding was removed by eliminating its dependency path, without an audit
exception, renamed fork or forced downgrade.

## Historical finding — 2026-10-06

Native check: `npm audit --audit-level=high --ignore-scripts`.
Result: **3 high entries**, all in `@google/clasp -> micromatch -> braces`.
Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
(CVE-2026-93687; advisory reviewed 2026-10-02). No patched version is listed.

The vulnerable recursive brace-pattern processing can exhaust a Node process's
stack if it receives deeply nested patterns. This dependency exists only in the
developer staging CLI; the five production Apps Script files do not use npm or
this package. CI installs clasp but does not run its deployment/file matcher.

The inspected clasp 3.4.1 code loads ignore patterns from `.claspignore` or an
environment-selected file, then passes them to micromatch. Its project path can
also be overridden by environment configuration, which could defeat target
checking in a wrapper that relies on the working directory alone.

Mitigation in `scripts/staging.js`:
- Generate and require an empty, regular, non-symlink `.claspignore`.
- Validate the exact source-file allowlist before invoking clasp.
- Pass explicit `--project` and `--ignore` paths, overriding environment defaults.
- Refuse altered/missing ignore content before starting the process.

Two behavioral regressions failed before these corrections and pass afterward.
No untrusted patterns are accepted through the guarded staging path. This assumes
a trusted local working tree; it does not prevent hostile concurrent local edits
or protect direct, unrestricted use of the clasp CLI.

Initial disposition was to defer the upstream fix and mitigate the staging path.
The suggested forced downgrade to clasp 2.5.0 was incompatible and was not applied.
The original audit exited nonzero. The removal above supersedes that deferral;
continue native dependency auditing on every dependency change/release.
