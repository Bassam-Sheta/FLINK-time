# Reviewed local runtime subsets

These are application source, not new npm dependencies or remote integrations.
`node scripts/embed-local-libraries.js` embeds the checked-in inputs into the
existing three-file Google deployment (`Code.gs` and `Portal.html`). `--check`
verifies exact source equality offline; `tests/local-libraries.test.js` enforces
it and identical enrollment handlers across the rendered portal views. Do not
edit generated blocks independently.

## Password KDF

`vendor/sjcl-password-kdf.js` derives from SJCL 1.0.8 at immutable commit
`2a6ed4a22449334de2dd9b4e960af679e0e87303`, under its BSD-2-Clause option. The
copyright, redistribution conditions and disclaimer are retained in the input
and embedded backend.

Reviewed inputs from
`https://github.com/bitwiseshiftleft/sjcl/tree/2a6ed4a22449334de2dd9b4e960af679e0e87303`:

| Input | SHA-256 of upstream bytes |
| --- | --- |
| `core/sha256.js` | `c13e26432895c74f8ae197f4e181121f85363b93a8a0b3a9e1a098969790c442` |
| `core/bitArray.js` | `52c5acc24193c8d976908c0a446fbbd53c654563d7feabce8c5f34d345c5a65a` |
| `core/codecString.js` | `f8d5682882ab66bb320d21270975f94d5c3c9c522890720eda88d3f7a44d4293` |
| `core/codecHex.js` | `6666a825e61a10ed38b7a47fe35ee6af7cb47aea98a54fc9d6835b0e1e50a9b8` |
| `core/hmac.js` | `f12858d7f9db5c72225d17fdc9a3e7c8f22b2e8ddbdf246fbea3d3660a5a50ce` |
| `core/pbkdf2.js` | `22ce7542834782f47ea38cbb822d0323c38b296f57c3661a14d879f6ecc51d7e` |
| `LICENSE.txt` | `ef430277d3cca1d3e7cdb6d4a61d7ff1eb208c4c2058602d2b361aaab60cd9c0` |

The local subset removes unused bit-array operations and reverse codecs, wraps
the retained algorithms in a private namespace, substitutes `Error` for SJCL's
invalid-parameter exception and compacts equivalent control flow/formatting.
It excludes AES, modes, ECC, JSON encryption, RNG/entropy collection, caching,
network/DOM access and module-loader execution. No complete SJCL bundle runs.
Only SHA constants survive derivations; password-dependent HMAC state is local
to each invocation. Internal derivation parameters are checked before both
Node and Apps Script paths (1–1,000,000 integer iterations; 1–1,024 output bytes).
Stored password verification still requires at least 10,000 iterations and
uses the existing 32-byte output, salt/pepper and constant-time comparison.

Independent Node crypto/RFC vectors cover existing stored formats, wrong
passwords, UTF-8/NUL inputs, keys/salts crossing SHA blocks, partial and multiple
output blocks, higher costs and malformed parameters. These tests and source
review are not a third-party cryptographic certification. `npm audit` does not
cover vendored source; no clearance of other SJCL primitives is implied.

## Authenticator QR

`vendor/nayuki-qr.js` embeds Project Nayuki's MIT-licensed encoder from
`typescript-javascript/qrcodegen.ts` at immutable commit
`3c6d0b3cefb4e049dc337e82237c9644399716a8`:

- Upstream TypeScript SHA-256:
  `1dc03fb5a10e0e2318ea162755bbdb9977ca6ce52cff959e9c9b6deafdccda9c`.
- Compiled body SHA-256, enforced by the regression test:
  `eed4a1cc7f7d6a5bd52b60539afe7a4ad786a7f7bd71559b780c9a7d59981244`.
- The initial compilation used installed Node 24.19.0
  `stripTypeScriptTypes(..., {mode:'transform'})` (experimental warning retained)
  and the existing Playwright 1.63.0 Babel printer: comments/source maps off,
  compact printing, no extra transforms for the JavaScript input. Newlines were
  added after semicolons only after checking that no literal contained one.
  The embedded body was independently compared exactly with that output.
  Normal builds require neither TypeScript transformation nor network access.

The reviewed encoder is pure arithmetic and arrays: no fetch, imports, runtime
dependencies, telemetry, storage, DOM access or evaluation. Its wrapper limits
input to 1,024 characters and uses medium error correction with automatic mask
selection and no ECC boosting. The portal validates the otpauth
scheme and constructs only numeric SVG geometry using DOM methods; seeds are
not placed in URLs, labels or logs. The manual key remains available if the
encoder fails. Copyright and MIT permission/disclaimer are retained inline.

The independent test-only decoder reads the rendered matrix, format BCH,
masking/interleaving and every Reed-Solomon syndrome without calling the
encoder; it also rejects a corrupted module. Its standard tables are referenced
from [error correction](https://www.thonky.com/qr-code-tutorial/error-correction-table)
and [alignment positions](https://www.thonky.com/qr-code-tutorial/alignment-pattern-locations).
Local Chrome has no `BarcodeDetector`, so this is clean-matrix/DOM verification,
not a physical phone-camera scan. Real-device Google staging scan acceptance
remains owner-local and must never be recorded.
