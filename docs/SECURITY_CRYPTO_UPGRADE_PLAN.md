# FLINK Time — Remaining Crypto Security Upgrade Plan

Status: **Source implementation complete; production KMS provisioning, migration, and final cutover still require deployment-owner activation**

The repository now contains the source changes for both items below. The remaining steps are deployment/runtime activation and verification:

1. Upgrade password storage from the current PBKDF2-HMAC-SHA256 work factor of 10,000.
2. Replace the custom TOTP secret-at-rest encryption with Google Cloud KMS.

The rollout is deliberately split into measurable phases so production authentication is never changed blindly.

---

## 1. Current production baseline

### Passwords

Current format:

```
$pbkdf2$v1$i=<iterations>$<salt>$<hash>
```

Current work factor:

```
PBKDF2_ITERATIONS = 10000
```

The stored format already includes the iteration count. That means old and new hashes can coexist during a transparent migration.

### TOTP secrets

Current active and pending TOTP secrets are stored in the Credentials sheet.

Current encrypted format:

```
enc$v1$<iv>$<ciphertext>$<tag>
```

The encryption key is derived from the FLINK server pepper stored in Apps Script Script Properties.

This encryption is authenticated, but it is custom application cryptography. The target state is a managed Google Cloud KMS symmetric encryption key whose raw key material is never available to FLINK Time.

---

# Phase A — Measure PBKDF2 on the actual Apps Script runtime

## Prepared helper

A private Apps Script function is included in this branch:

```
benchmarkPasswordKdf_()
```

It:

- cannot be called through `google.script.run` because the name ends in `_`;
- never reads or modifies a real user;
- uses fixed non-secret benchmark input;
- measures the exact PBKDF2 implementation used by the Apps Script runtime;
- tests progressively larger work factors;
- stops early if execution becomes expensive;
- estimates the runtime of 600,000 iterations.

## How to run it

After this preparation code is deployed to the Apps Script development project:

1. Open the Apps Script editor.
2. Select `benchmarkPasswordKdf_`.
3. Click **Run**.
4. Approve existing permissions if Google asks.
5. Copy the returned/logged JSON result.
6. Record the values for:
   - 10,000 iterations
   - 25,000 iterations
   - 50,000 iterations
   - 100,000 iterations if it completes
   - estimated 600,000 runtime

Do not change `PBKDF2_ITERATIONS` yet.

## Decision rule

### Path A1 — 600,000 is practical

Use this path if the actual Apps Script runtime can perform the target work factor at an acceptable login latency.

Target implementation:

```
PBKDF2-HMAC-SHA256
600000 iterations
32-byte output
16-byte unique salt
server-side pepper retained
```

Then implement transparent rehashing.

### Path A2 — 600,000 is not practical

If the pure Apps Script implementation would make authentication unacceptably slow, do **not** choose an arbitrary weak number just because Apps Script is slow.

Instead:

1. Keep the current verifier temporarily for legacy hashes.
2. Add a small native password-KDF service in Google Cloud.
3. Use native PBKDF2-HMAC-SHA256 at the approved work factor, or Argon2id if the service design is changed accordingly.
4. Keep the FLINK application session/RBAC layer unchanged.
5. Migrate users transparently on successful password verification.

The benchmark decides between A1 and A2.

---

# Phase B — Password hash migration design

## New hash version

Use a new version marker rather than silently changing the meaning of `v1`.

Target format:

```
$pbkdf2$v2$i=600000$<salt>$<hash>
```

If the benchmark requires a native external verifier, the format must still include the algorithm/version/work factor explicitly.

## Backward-compatible verification

Verification order:

1. Parse the hash.
2. Reject malformed formats.
3. Verify using the work factor stored in that hash.
4. Constant-time compare.
5. If authentication succeeds and the stored version/work factor is below policy:
   - generate a fresh salt;
   - create the new hash using the approved target;
   - update `PasswordHash`;
   - do **not** force a user password change solely because the storage format changed;
   - do **not** increment `PasswordVersion` solely for transparent rehash, because the user's actual password did not change;
   - write a security/audit event such as `PASSWORD_HASH_UPGRADED`.

## Important MFA interaction

For MFA-enabled accounts, a correct password is only the first authentication factor.

The migration code must not weaken existing MFA behavior.

Recommended sequence:

1. Verify the password.
2. Determine whether rehash is required.
3. Preserve the existing MFA challenge logic.
4. Rehash only after a valid password has been established under the login-state lock.
5. Never create a FLINK session until MFA completes when MFA is enabled.

A user who knows the correct password but fails MFA may cause at most one storage-format upgrade; this does not authenticate that user or create a session.

## Rollout

1. Deploy verifier that understands both v1 and v2.
2. Keep v1 verification available.
3. Enable v2 hashing for all newly created/reset passwords.
4. Transparently upgrade v1 hashes after successful password verification.
5. Add reporting:
   - number of v1 hashes remaining;
   - number of v2 hashes;
   - last hash migration timestamp.
6. After the migration window, force password reset only for accounts that never returned and still use obsolete hashes.
7. Remove v1 **creation** immediately after cutover.
8. Remove v1 **verification** only when no valid legacy accounts remain.

---

# Phase C — Google Cloud KMS foundation

## Cloud project

Use a **standard Google Cloud project** associated with the Apps Script project.

The production Apps Script deployment identity must be intentionally controlled. Do not use a personal account that may leave the company.

Recommended names:

```
Project: flink-time-prod
Key ring: flink-time-security
Crypto key: flink-totp-secrets
```

Location should follow FLINK's organization/data-residency policy. Use one location consistently; do not recreate the same logical key in multiple locations.

## Enable Cloud KMS

Example:

```bash
gcloud services enable cloudkms.googleapis.com --project="$PROJECT_ID"
```

## Create key ring

Example:

```bash
gcloud kms keyrings create flink-time-security \
  --location="$LOCATION" \
  --project="$PROJECT_ID"
```

## Create software-backed symmetric key

Example:

```bash
gcloud kms keys create flink-totp-secrets \
  --location="$LOCATION" \
  --keyring="flink-time-security" \
  --purpose="encryption" \
  --rotation-period="90d" \
  --project="$PROJECT_ID"
```

Use a symmetric `ENCRYPT_DECRYPT` key.

## Least-privilege IAM

Grant the Apps Script deployment identity only:

```
roles/cloudkms.cryptoKeyEncrypterDecrypter
```

Grant it at the individual CryptoKey level rather than project-wide.

Example:

```bash
gcloud kms keys add-iam-policy-binding flink-totp-secrets \
  --location="$LOCATION" \
  --keyring="flink-time-security" \
  --member="user:$DEPLOYMENT_OWNER_EMAIL" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" \
  --project="$PROJECT_ID"
```

Do not give the running application `roles/cloudkms.admin`.

Keep key administration and key use separated where practical.

---

# Phase D — Apps Script KMS integration

## Required manifest scopes

When KMS code is activated, add:

```
https://www.googleapis.com/auth/script.external_request
https://www.googleapis.com/auth/cloudkms
```

Keep all existing scopes.

If a URL fetch allowlist is used, restrict it to:

```
https://cloudkms.googleapis.com/
```

Because the project has explicit OAuth scopes, these scopes must be present before the KMS code can work.

## Authentication to KMS

Use:

```javascript
ScriptApp.getOAuthToken()
```

and send it to Cloud KMS through:

```javascript
UrlFetchApp.fetch(...)
```

with:

```
Authorization: Bearer <token>
```

Do not store a Google service-account JSON key in Script Properties, Sheets, Drive, or source control.

## Configuration

Store only non-secret KMS resource metadata in Script Properties:

```
FLINK_KMS_KEY_RESOURCE=
projects/<project>/locations/<location>/keyRings/flink-time-security/cryptoKeys/flink-totp-secrets

FLINK_KMS_MODE=DUAL_READ
```

Allowed modes:

```
DISABLED
DUAL_READ
KMS_REQUIRED
```

The KMS key material itself never leaves Cloud KMS.

---

# Phase E — New TOTP ciphertext format

Use a versioned format:

```
kms$v1$<base64-kms-ciphertext>
```

KMS ciphertext already identifies the key version required for decryption, so key rotation does not require embedding the version separately in the FLINK record.

## Additional authenticated data

Bind each ciphertext to both purpose and user:

```
FLINK_TOTP_V1|<UserID>
```

Pass this value as Cloud KMS additional authenticated data on both encrypt and decrypt.

This prevents a valid encrypted TOTP secret from simply being copied from one user record into another user's credential row.

## Service boundary

Create a dedicated internal service such as:

```
KmsSecretService.encryptTotpSecret(userId, plaintextSecret)
KmsSecretService.decryptTotpSecret(userId, storedCiphertext)
```

TOTP verification should never call generic custom encryption directly.

---

# Phase F — Safe TOTP migration

## Stage 1 — Dual-read

Set:

```
FLINK_KMS_MODE=DUAL_READ
```

Behavior:

- `kms$v1$` → decrypt only through Cloud KMS.
- `enc$v1$` → decrypt with the existing legacy decryptor only for migration.
- unversioned plaintext → reject unless an explicitly controlled migration routine identifies an actual historical record that must be converted.
- new MFA enrollments → write only `kms$v1$`.
- MFA replacement → write only `kms$v1$`.

Never fall back from a failed `kms$v1$` decryption to the legacy decryptor.

## Stage 2 — Batch migration

Add a private/privileged migration job that:

1. reads credential records in bounded batches;
2. selects active `TotpSecret` and `PendingTotpSecret` values that are not already `kms$v1$`;
3. decrypts the old value locally;
4. immediately encrypts the raw secret with Cloud KMS and UserID-bound AAD;
5. writes the KMS ciphertext back;
6. verifies the new ciphertext by decrypting it through KMS before moving to the next record;
7. logs only UserID/status — never plaintext or ciphertext;
8. persists a migration cursor;
9. can safely resume after interruption.

For the current FLINK deployment size this should be operationally small, but it should still use the existing chunked-job pattern.

## Stage 3 — Verification

Required checks:

- no active account has `enc$v1$` in `TotpSecret`;
- no active pending enrollment has legacy ciphertext;
- every MFA-enabled user can complete a real TOTP login;
- Super Admin step-up works;
- audit logs contain no secret values;
- backup/restore tests pass with KMS ciphertext;
- KMS failures return controlled fail-closed authentication errors.

## Stage 4 — KMS required

Set:

```
FLINK_KMS_MODE=KMS_REQUIRED
```

At this point:

- all newly stored TOTP secrets must start with `kms$v1$`;
- normal authentication must reject legacy/unversioned secrets;
- legacy decryption code is inaccessible from normal login paths;
- a separate offline/manual migration/restore path may remain temporarily for old backups only.

---

# Phase G — Key rotation

Configure automatic symmetric-key rotation at 90 days unless FLINK policy requires another interval.

Rotation creates a new primary version for new encryption. Previous versions remain available to decrypt existing ciphertext until those versions are disabled/destroyed.

Do not destroy old key versions merely because rotation occurred.

Optional later maintenance job:

1. identify records encrypted before the current primary version;
2. decrypt with KMS;
3. re-encrypt with the current primary version;
4. verify;
5. only then consider disabling/destroying old versions after retention and backup requirements are satisfied.

---

# Phase H — Failure handling

## KMS unavailable

For an MFA-protected login:

- fail closed;
- do not bypass MFA;
- do not fall back to local legacy encryption for a `kms$v1$` record;
- return a generic temporary authentication/security-service error;
- log correlation ID, HTTP status, and KMS operation type;
- never log TOTP plaintext or KMS ciphertext.

Retries:

- no retry for 400/401/403;
- small bounded retry for 429 and transient 5xx;
- never retry indefinitely inside Apps Script.

## PBKDF2 migration failure

If legacy password verification succeeded but transparent rehash fails:

- do not corrupt the existing hash;
- keep the previous hash intact;
- record a migration failure event;
- authentication policy for that event must be decided explicitly during implementation testing.

Preferred production behavior is to preserve availability while leaving the old verified hash untouched, unless failure indicates a broader integrity/security incident.

---

# Phase I — Tests required before production

## Password tests

- v1 password still verifies.
- v2 password verifies.
- wrong password fails against both.
- malformed iteration count fails safely.
- work factor cannot be client-controlled.
- new account creates only target version.
- password change creates only target version.
- admin reset creates only target version.
- successful legacy verification upgrades hash exactly once.
- transparent rehash does not change PasswordVersion.
- concurrent legacy logins do not corrupt credentials.
- MFA-required login does not mint a session before MFA.
- timing comparison remains constant-time.

## KMS unit tests

Mock Cloud KMS transport and test:

- successful encrypt.
- successful decrypt.
- wrong UserID/AAD fails.
- malformed `kms$v1$` fails.
- 401/403 fail closed.
- 429 bounded retry.
- 5xx bounded retry.
- KMS ciphertext never appears in logs.
- no fallback from KMS failure to legacy decrypt.
- new enrollments write KMS format only.

## Migration tests

- `enc$v1$` active secret converts to `kms$v1$`.
- legacy plaintext historical fixture, if retained, converts once.
- KMS record is skipped idempotently.
- migration can resume from cursor.
- failure leaves original record intact.
- post-write KMS verification required before marking migrated.
- pending enrollment migration is safe.
- root Super Admin MFA continues working.

## Browser acceptance

Run existing user flow plus:

- Super Admin login with MFA.
- step-up authentication.
- MFA enroll/replace.
- user login with migrated KMS TOTP.
- password upgrade path.
- logout/session invalidation.

---

# Phase J — Production rollout order

1. Merge this preparation/benchmark helper.
2. Run `benchmarkPasswordKdf_()` in the real Apps Script runtime.
3. Record benchmark results.
4. Choose Password Path A1 or A2.
5. Create/associate the standard Cloud project.
6. Enable Cloud KMS.
7. Create the symmetric TOTP key.
8. Grant key-level Encrypter/Decrypter to the deployment identity.
9. Implement KMS service + scopes under `DUAL_READ`.
10. Run automated tests and Chromium acceptance.
11. Deploy new Web App version.
12. Test KMS with one controlled test user.
13. Migrate a small batch.
14. Verify login and Super Admin step-up.
15. Migrate all TOTP records.
16. Verify backups/restore and audit.
17. Switch to `KMS_REQUIRED`.
18. Implement the chosen password-v2 path.
19. Transparently migrate password hashes.
20. Monitor migration counts and KMS errors.
21. Remove normal runtime access to legacy TOTP decryption.
22. Retain documented disaster-recovery support for older backups until their retention period expires.

---

# Rollback rules

## TOTP

During `DUAL_READ`, keep the original legacy ciphertext until the KMS ciphertext has been successfully written and verified.

Never overwrite a legacy secret before a KMS decrypt round-trip succeeds.

If KMS rollout must be stopped:

- stop new migration jobs;
- remain in `DUAL_READ`;
- do not destroy the KMS key/version;
- do not rewrite KMS secrets back into custom encryption.

## Passwords

The verifier remains multi-version during rollout.

Rollback means:

- stop creating the new format;
- continue verifying both existing formats;
- never downgrade a v2 hash to v1;
- resolve the performance problem and resume migration.

---

# Definition of done

The two remaining findings are closed only when all of the following are true:

- production password hashes use the benchmark-approved strong KDF target;
- legacy password hashes are either migrated or subject to a forced-reset policy;
- no normal production path creates 10,000-iteration hashes;
- all active TOTP secrets use `kms$v1$`;
- no normal production authentication path relies on the custom secret cipher;
- Cloud KMS IAM is limited to the required key-use role;
- KMS automatic rotation is configured;
- Admin/deployment identities are documented and controlled;
- KMS outage behavior is fail-closed;
- password/KMS migration tests are green;
- Chromium acceptance is green;
- the final merged `main` workflow is green.
