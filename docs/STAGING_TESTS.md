# Isolated Google runtime verification

## Current result and scope

The local baseline is commit `9e6db78`. Its Windows action-inventory test failed
because it searched CRLF source using an LF-only delimiter. Normalizing the
test's source string fixes the boundary without weakening permission assertions.

Clasp **3.4.1** is pinned in the developer lockfile. Dependency lifecycle scripts
are disabled. Developer dependencies are not uploaded or used by the live app.
The local browser suite uses synthetic RPC mocks: it is **not** evidence of real
Google authorization, MFA, Sheet latency, embedding, triggers or production load.

## Prerequisites requiring the installation owner's participation

1. Identify the production script ID. Create a **new empty, disposable standalone
   diagnostic script**, separate from production and its books.
2. Associate the diagnostic script and your Desktop OAuth client with the same
   standard Google Cloud project. Enable the Apps Script API and the user's Apps
   Script API setting. Use least privilege; do not copy production credentials.
3. Copy `scripts/staging.config.example.json` to `.clasp-staging.json` at the repo
   root. Replace both IDs, Cloud project ID and the named account. The tool
   rejects missing/placeholder IDs, identical targets and unexpected fields.
4. Keep OAuth client/authorization files outside version control. Do not paste
   passwords, MFA secrets, access tokens or refresh tokens into chat or logs.

These configuration checks prevent common mistakes; a supplied ID is not proof
of ownership or staging status. The owner must confirm the actual Google target.

## Prepare and authorize

```powershell
npm ci --ignore-scripts
npm run staging -- prepare
```

Preparation writes an ignored `.staging/<scriptId>/` directory. It refuses to
overwrite an existing bundle. Its upload contains precisely the five app files
and a developer-only `RuntimeChecks.gs`; no Node tests, credentials or installer.
It adds `executionApi.access = MYSELF` **only to the staging manifest**.

From that generated directory, run the locally pinned CLI (adjust its relative
path if needed):

```powershell
node ../../node_modules/@google/clasp/build/src/index.js --user flink-staging login --creds "C:\private\oauth-client.json" --use-project-scopes --include-clasp-scopes
```

Complete Google login/consent yourself. The named account must own the diagnostic
script. Use the account name selected in your configuration. Scripts.run does
not support service accounts. No production authorization changes are required.

## Upload and measure

From the repository root:

```powershell
npm run staging -- check
npm run staging -- push --confirm-staging
```

Before pushing, inspect the exact target and file list. **Clasp push replaces the
remote project's content. Never point this bundle at an existing application.**
In the diagnostic Apps Script editor, deploy as **API Executable**, accessible
only to yourself. Then:

```powershell
npm run staging -- run --confirm-staging
```

The runner verifies bundle hashes and refuses changed/stale source or target.
The remote private test checks the exact script ID and refuses a configured
Master book. It verifies a PBKDF2 vector, measures exact-match lookups at 10 and
5,000 synthetic rows, trashes only the exact spreadsheet it created, and runs
the existing KDF calibration with synthetic inputs. Cleanup failure fails the
run. Measurements are stored locally only after a valid passing response; an
Apps Script error cannot count as a successful result even if clasp exits zero.

This is **runtime-primitives coverage**, not complete app acceptance. It makes
no settings changes and does not run concurrent users against production. A
benchmark's recommendation must not be applied automatically.

## Remaining live application tests

Use a second, owner-approved staging application with synthetic accounts/books:

- Capture the exact deployed version and schema; test real Google identity.
- Test all three portals, login/MFA/recovery, role/workspace denials and Site embeds.
- Measure cold/warm login, start, stop, weekly list, rows/bytes and p50/p95/p99.
- Increase load gradually; verify duplicates, conflicts, lock timeout and retries.
- Run actual scheduled triggers and measure daily job cost.
- Inject partial failures and rehearse consistent backup/restore and rollback.

Do not grant an API executable to ordinary app users or expand the production
RPC surface to enable testing. Review native runtime and web-app identity
differences. Google authentication state and traces may contain secrets: keep
live artifacts local, restrict access and do not use the mocked CI upload path.

## Verified public limits (2026-10-01)

| Limit | Consumer | Google Workspace |
| --- | --- | --- |
| Execution time | 6 minutes | 6 minutes |
| Concurrent executions per user | 30 | 30 |
| Concurrent executions per script | 1,000 | 1,000 |
| Trigger runtime per day | 90 minutes | 6 hours |
| Triggers per user per script | 20 | 20 |
| Properties reads/writes per day | 50,000 | 500,000 |
| Email recipients per day | 100 | 1,500 |

Properties: 9 KB per value, 500 KB per store. Cache: 100 KB per value, 1,000 items
with possible early eviction. Browser RPC: 10 simultaneous calls, unordered
completion. Sheets API read/write quotas separately: 300/min/project and
60/min/user/project; 180-second processing timeout. These API counts are not
a published per-call allowance for SpreadsheetApp. A recommended 2 MB API
payload is not a hard limit. Allocated Sheets cells count toward 10 million per
file. Account/trial restrictions and quotas can change; inspect project-specific
API quotas in Cloud Console. Do not substitute these tables for measurements.

## Sources

- https://github.com/google/clasp
- https://developers.google.com/apps-script/api/how-tos/execute
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/workspace/sheets/api/limits
- https://developers.google.com/apps-script/reference/cache/cache
- https://developers.google.com/apps-script/guides/html/communication
