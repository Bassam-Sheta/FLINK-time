# Single portal page + bounded setup status

Status: **implemented and verified locally, not deployed.**
Branch: `wp10-yearly-entry-routing`.
Scope: two changes — (1) bound the public `setup.status` hot path, (2) replace the
three near-identical portal files with one server-gated `Portal.html`.

No dependency, CDN, external backend, scope, permission or audit behavior was
changed. The mandatory MFA, recovery, server authorization and Before/After
audit model are untouched.

## 1. `setup.status` initial-load cost

`SetupService.getSetupStatus` is the first unauthenticated call every portal makes
on load. It scanned the whole `Accounts` table plus the workspace list on every
call just to return two booleans.

Measured with `tests/helpers/setup-status-fixture.js` (transferred cells only):

| Accounts rows | Before fix | After fix |
| --- | ---: | ---: |
| 10 | 214 | 40 |
| 5,000 | 80,054 | 40 |

The fix reads the `SETUP_COMPLETE` setting first and returns early while setup is
incomplete, then verifies the two invariants with bounded `findRowsByKey` probes
(`Role = SUPER_ADMIN` and the three live workspace statuses) instead of
full-table transfers. Semantics are unchanged: a non-deleted Super Admin and a
non-archived workspace are still required, and the public response is still only
`{initialized, setupComplete}` / `{initialized, setupComplete, setupRequired}`.

Regression: `tests/setup-status-cost.test.js` (4 cases, including
size-independence and the metadata-exposure guard).

## 2. One `Portal.html` instead of three

Before: `User.html`, `Admin.html`, `SuperAdmin.html` were 96–98% line-identical
(180–413 differing lines each). After: one `Portal.html` (245,063 bytes) replaces
678,246 bytes of duplicated HTML.

`doGet` reads `?view=user|admin|superadmin`, sets `template.portalView = view`
and evaluates `Portal.html`. Role-specific regions are wrapped in server-side
`<? if (portalView === '...') { ?>` gates, so:

- the shared core is written once;
- the frame-embeddable employee view (`ALLOWALL`) never receives the gated
  Admin/Super Admin deltas;
- the Admin and Super Admin views stay frame-blocked (`DEFAULT`).

### Faithful-merge evidence

The merge was generated from the three files and then verified by rendering
`Portal.html` for each view and comparing to the original file it replaced:

```
OK   user: rendered Portal.html matches User.html byte-for-byte
OK   admin: rendered Portal.html matches Admin.html byte-for-byte
OK   superadmin: rendered Portal.html matches SuperAdmin.html byte-for-byte
gated blocks: 53
```

The renderer (`tests/helpers/portal-template.js`) mirrors the documented Apps
Script scriptlet semantics. Permanent guards:

- `tests/portal-single-source.test.js` — one gated template, every scriptlet is a
  simple `portalView` gate, each view keeps its own deltas and never inherits
  another view's, shared core byte-identical across views, `doGet` injects the
  view and keeps user-only `ALLOWALL`.
- Updated role/font/step-up/QR/installer/staging tests render the portal per view.

### Pre-existing observation (not introduced here)

The original portals already shipped the shared privileged client code to every
role and relied on navigation gating plus server authorization. The merge
preserves that model exactly; it neither widens nor narrows it.

## Verification run (working tree)

- `npm test` — 647/647 pass.
- browser suite (`chrome.config.cjs`) — 26/26 pass.
- `node scripts/embed-local-libraries.js --check` — verified.
- `git diff --check` — clean.

## Not done (requires explicit approval)

- Deployment of any kind; the staging Version 2 still contains `1be2712`.
- The installer release pin still points at the previous commit and must only
  advance after the release gates.
- Live field latency was not measured; these are offline, deterministic counts.
