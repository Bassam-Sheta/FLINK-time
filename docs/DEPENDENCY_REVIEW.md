# Developer dependency review — 2026-10-06

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

Disposition: **upstream fix deferred; staging-path exposure mitigated**.
Next review: **2026-10-13**, or immediately when a patched upstream version exists.
Keep clasp pinned. The suggested forced downgrade to clasp 2.5.0 is an incompatible
change and was not applied. The native audit still exits nonzero; the CI advisory
gate has not been bypassed, and these results are not a release approval.
