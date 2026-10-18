# Password path and private MFA QR — local evidence

Baseline: `d03ec60`; scope: password derivation, login-time self radar and
authenticator enrollment in all three portals. This patch is **not deployed**;
approved Google staging Version 2 still contains `1be2712`. No production,
password, MFA credential, mail setting, workspace or installer pin was changed.

## Comparable synthetic baseline

Command: `node scripts/benchmark-password-path.js d03ec60`.
Windows, Node 24.19.0; Apps Script-like VM with no native crypto available to the
application. The old Utilities HMAC boundary is simulated by Node crypto; the
new path executes the embedded JavaScript implementation. Inputs are synthetic
and identical; PBKDF2-HMAC-SHA256, 10,000 iterations, 32 output bytes. Code
loading is outside the timer. Three equivalent fresh-VM-context samples per side, each
with fresh repository/crypto state; both timing cohorts run before the large
radar allocations. No controlled network/CPU throttling, browser or Google
request latency is included. Earlier exploratory warm-isolate samples are not
used for the following final comparison.

| Local KDF | Before | After |
| --- | ---: | ---: |
| Samples (ms) | 393.08 / 363.43 / 367.97 | 33.15 / 33.09 / 33.74 |
| Median (ms) | 367.97 | 33.15 |
| Range (ms) | 363.43–393.08 | 33.09–33.74 |
| Utilities HMAC calls per derivation | 10,000 | 0 |

This is an **11.10× local KDF-component** median improvement, not a measured
Google or whole-application speedup. The independent expected digest is checked
for every timed run. Work factor, stored verifiers, salts, pepper, account
locks, rate limits and MFA are unchanged; no cheaper password hash is used.

## Self radar transfer cost

Real repository and radar code against synthetic Sheets: one ordinary user's
timer/member/project at noncontiguous physical rows, including near the end of
the grid. Workspace authorization resolution is stubbed; the following counts
cover the three tables, not an authenticated end-to-end request.

| Rows per table | Before transferred cells | After transferred cells |
| --- | ---: | ---: |
| 10 | 385 | 35 |
| 50,000 | 1,750,035 | 35 |

All-method Spreadsheet boundary calls change from **9 to 30**: TextFinder point
lookups use more methods but avoid transferring the entire growing tables.
This is a transfer/memory improvement, not a claim of fewer calls or measured
Google latency. An idle ordinary user transfers zero cells and skips both name
tables. Managers retain the full authorized radar; empty manager radar skips
unneeded name tables. Existing point-lookup compatibility fallbacks remain;
this evidence describes the healthy TextFinder path, not a fault-path bound.

## Payload cost and behavior

The deployable HTML is an Apps Script HTML template: `<? ?>` gates render
server-side, so a view's payload is the rendered application HTML for that view
before Google's own host wrapper. UTF-8 byte counts are uncompressed; they
exclude the Google wrapper/network overhead.

| File | Before bytes | After bytes | Current single-portal bytes |
| --- | ---: | ---: | ---: |
| `Code.gs` | 718,301 | 728,601 | 729,269 |
| `Portal.html` (was `User.html`) | 205,083 | 227,506 | see below |
| `Admin.html` (now gated in `Portal.html`) | 200,969 | 223,392 | — |
| `SuperAdmin.html` (now gated in `Portal.html`) | 204,925 | 227,348 | — |

The three near-identical portals were then consolidated into one
`Portal.html` (245,063 bytes) served by `?view=user|admin|superadmin`. That
replaces 678,246 bytes of duplicated HTML on the previous branch with a single
template, while each view still renders byte-for-byte identical output to the
file it replaced. The private encoder and safer UI still add about 22.4 KB
relative to the original employee payload. This is an explicit
feature/security payload cost, **not payload slimming**. QR work runs only on
enrollment; no external image/script/CDN or new deployable file is introduced.
The independent WP11 shared-source draft is not merged or overwritten here;
any later combination must preserve these new local-library/QR blocks.

Scanning installs the TOTP seed; entering a current six-digit code proves that
the authenticator is connected. It remains mandatory. The key and numeric SVG
geometry stay in memory, are removed on exit/expiry, and never enter storage,
an external request or a secret-bearing image URL. A reproduced late-confirm
response previously reopened recovery codes after leaving enrollment; session
and screen-generation checks now discard it. Reproduced late session-validation
errors also hid/cleared a newer sign-in; request-token and enrollment-generation
guards now reject those stale UI effects while current-token authentication
rejections still clear the session. Manual setup still works if QR
generation fails. See [local source pins/licenses](LOCAL_LIBRARIES.md).

A reproduced page-exit gap also retained enrollment material in the document.
The `pagehide` handler clears the key, code and SVG before a history-cache freeze,
discards pending enrollment responses and drops the restricted in-memory token.
The regression dispatches that lifecycle event deterministically; real browser
history-cache and Google iframe behavior remain live-acceptance checks. QR cleanup
assertions count SVG children explicitly rather than merely checking empty text.

## Verification and remaining gates

The initial new regressions failed on the 10,000 Utilities calls, invalid KDF
parameters, whole-table self-radar reads, idle name-table reads and absent QR.
The browser late-confirm cancellation regression was also observed failing
before its guard was added. Independent QR decode verifies the actual DOM SVG
on all three portal roles, not just the encoder object.

Final unchanged application-source verification:

- `npm test`: **638/638** passing, zero failures/skips.
- `node node_modules/@playwright/test/cli.js test --config .opencode/browser-control/chrome.config.cjs`:
  **26/26** passing on installed signed Chrome **155.0.8059.40**, Playwright
  **1.63.0**, sandbox enabled; local synthetic routes, desktop default viewport
  plus a 375×812 enrollment check; traces/video/automatic screenshots disabled.
- `node scripts/embed-local-libraries.js --check`: exact embedded sources pass.
- `git diff --check`: pass.
- `npm audit --omit=optional`: **0 known npm vulnerabilities**; this is not a
  vendored-source or entire-runtime security certification.

Failure-injection notices are expected and are not hidden. Mocked Chrome/Sheets
checks do not prove
live Google quotas, app-wide latency, role acceptance, camera scanning or
zero-defect operation. No field INP/LCP/CLS or production scalability measurement
was made. Growing entry/report/rollup scans, workspace fan-out and remaining
audit/backup recovery work remain separate unresolved costs.

The changes retain the Apps Script execution/concurrency limits; they do not
raise quotas or bypass locks. Official references:
[performance guidance](https://developers.google.com/apps-script/guides/support/best-practices)
and [quotas](https://developers.google.com/apps-script/guides/services/quotas)
(six minutes per normal execution; current published limits remain authoritative).

Before live testing, use a reviewed exact-target source upload, fresh saved-source
verification and a matched staging deployment; the old local source transport
must keep refusing an unapproved revision. Owner login/enrollment/recovery-code
screens remain private and must be closed explicitly before any portal capture.
