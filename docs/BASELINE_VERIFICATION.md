# WP0 verification — 2026-10-01

## Scope

Local source baseline: `9e6db78bd5e63f2f81092760125c9d57192a5ed2`.
Working branch: `wp0-runtime-verification`. No production files were changed or
deployed. The ZIP referenced in the proposed design is not present locally.
The owner chose to continue offline before Google authorization.

## Verified findings against this checkout

| Finding | Evidence / implication |
| --- | --- |
| Original suite was not green on Windows | 274/275 passed; the action-inventory test's LF delimiter did not match CRLF source. Normalizing line endings restores the unchanged parity assertions. |
| Session/master lookup foundation exists | `findSessionByTokenHashFast`, account `SessionEpoch`, bounded TextFinder lookups, session/user caches and targeted purge tests exist. WP1 is completion/measurement, not a rewrite. |
| Settings foundation exists | Catalog, validated patches and generated Super Admin settings UI exist. Not every catalog flag is wired to behavior. |
| Mandatory MFA remains incomplete | `MFA_REQUIRED` appears in the catalog, but login branches on `MfaEnabled` and issues a normal session to unenrolled users. No portal calls enrollment/confirmation. |
| Growing entry scans remain | `SheetRepository.listTimeEntries`, get/update paths use full TimeEntries table loading. |
| Privileged embedding differs from target | Admin/Super Admin currently retain frame restrictions. Do not remove them without an approved clickjacking solution. |
| KMS boundary needs a decision | Runtime manifest/code use Cloud KMS. Removing it merely to fit a service list would weaken existing protection. |
| Live benchmarks are prepared, not measured | Private KDF benchmark exists; new isolated clasp harness verifies crypto and Sheet primitives. No live timing or quota-consumption claim is made. |

## Local release checks

- All 281 unit tests pass after the CRLF portability fix and new staging checks.
- All six Chromium browser tests pass against synthetic local RPC mocks,
  including password/MFA-screen sequencing and untrusted-description rendering.
- Frozen `npm ci --ignore-scripts` succeeds; clasp is pinned to 3.4.1.
- Native npm advisory check: zero known findings at verification time.
- Registry signatures verified for 298 installed packages; 28 attestations
  verified. This does not prove absence of malicious code or future advisories.
- Chromium had been missing; the pinned Playwright browser was installed before
  rerunning acceptance tests. Initial missing-browser failures are not app bugs.
- Staging CLI refuses missing configuration before making a Google call.

These checks do not certify MFA enforcement, real Google identity, concurrent
app writes, native service quotas, trigger execution or Sites framing.

## Remaining gates

1. Owner-approved empty diagnostic script, Cloud project and local OAuth consent.
2. Real runtime-primitives results, followed by separate live staging-app tests.
3. Target-design implementation packages with test-first behavior changes.
4. Product/security decisions for admin embedding, KMS service scope and retention.
5. One PR for this WP; no automatic production push, merge or rollout.

Use `STAGING_TESTS.md` for exact authorization steps and official quota sources.

## Publication checks — 2026-10-06

- Unit suite now passes **283/283**, including two new staging-boundary regressions.
- A refreshed native audit reports **3 high dependency entries** for one unpatched
  `braces` advisory through `micromatch` and developer-only clasp. The earlier clean
  result above is historical; see `DEPENDENCY_REVIEW.md` for current reachability,
  mitigation and review date. The existing CI advisory gate remains failing.
- Staging now requires a generated empty ignore file and passes explicit project
  and ignore paths to clasp. Environment configuration cannot replace those paths.
- No Google staging operation or production deployment was performed.
