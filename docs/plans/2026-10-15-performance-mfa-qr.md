# Password-path performance and private MFA QR

Baseline: `d03ec60` on `wp10-yearly-entry-routing`. Requirements: mandatory
authenticator MFA, unchanged password KDF/cost/format, Google-only storage and
exactly one backend, three portals and the manifest. No production changes,
credential inspection, external QR service or dependency installation.

1. **Password KDF** — `apps-script/Code.gs`, a pinned, locally reviewed SJCL
   SHA-256/HMAC/PBKDF2 subset under `vendor/`, and
   `tests/password-kdf-performance.test.js`. First demonstrate that the existing
   Apps Script path makes 10,000 Utilities calls for a 10,000-iteration hash.
   Preserve PBKDF2-HMAC-SHA256, UTF-8 inputs, pepper, salt, output length, stored
   framing and configured iterations. Check independent Node/RFC vectors,
   Unicode/NUL/long inputs, multiblock keys and existing stored hashes. Compare
   three equivalent synthetic runs, service calls and backend bytes; do not
   equate local VM timings with Google latency.
2. **Self-scoped radar** — `apps-script/Code.gs`,
   `tests/dashboard-correctness.test.js` and a service/cell-count fixture. First
   reproduce whole-table transfer for an ordinary user's own timer. Read only
   that user's timer/member/project, with no name lookups when no visible timer
   exists. Preserve manager visibility, workspace denial and fail-closed reads.
   Verify small/50,000-row fixtures, displaced rows and isolation.
3. **Private QR enrollment** — all three portal files, a pinned local Nayuki QR
   encoder under `vendor/`, `tests/mfa-qr.test.js`, and
   `tests/browser/mandatory-mfa.spec.js`. First fail on the absent QR. Encode the
   server-returned otpauth URI locally, retain manual setup, explain the required
   six-digit confirmation, clear both key/QR on every exit, and discard late
   responses after cancellation. Check independent decoding/known matrices,
   all portal roles, no external requests, failure fallback and cleanup.

Embed the reviewed local sources deterministically without extra deployment
files; record pins/licenses and payload costs. Run targeted tests, `npm test`,
the existing signed-Chrome synthetic suite, `git diff --check` and `npm audit`.
Update the performance evidence and requirement documentation. Real Google
speed/scan acceptance and a matched staging deployment remain separate gates;
never capture an owner credential/enrollment screen.
