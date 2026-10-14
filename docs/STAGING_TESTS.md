# Isolated Google runtime verification

## Current result and scope

The local baseline is commit `9e6db78`. Its Windows action-inventory test failed
because it searched CRLF source using an LF-only delimiter. Normalizing the
test's source string fixes the boundary without weakening permission assertions.

Staging uses Google's official **google-auth-library 10.5.0** and the Apps Script
REST API. Clasp and its vulnerable file matcher have been removed. Dependency
lifecycle scripts are disabled. Developer dependencies are not uploaded or used by the live app.
The local browser suite uses synthetic RPC mocks: it is **not** evidence of real
Google authorization, MFA, Sheet latency, embedding, triggers or production load.

## Prerequisites requiring the installation owner's participation

1. Identify the production script ID. Create a **new empty, disposable standalone
   diagnostic script**, separate from production and its books.
2. Associate the diagnostic script and your Desktop OAuth client with the same
   standard Google Cloud project. Enable the Apps Script API and the user's Apps
   Script API setting. Use least privilege; do not copy production credentials.
3. Copy `scripts/staging.config.example.json` to `.staging.config.json` at the repo
   root. Replace both script IDs, Cloud project ID, owner's Google email and the
   Desktop OAuth client ID (the public ID, not its secret). The tool
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

Use the official Google Cloud CLI for interactive authorization, in a dedicated
configuration directory outside this repository. Run from the repository root
in a separate PowerShell window (replace the example private paths and email):

```powershell
$env:CLOUDSDK_CONFIG = 'C:\private\flink-staging-gcloud'
$scopes = node scripts/staging.js scopes
gcloud auth application-default login staging-owner@example.com --client-id-file="C:\private\oauth-client.json" --scopes="$scopes"
$env:FLINK_STAGING_CREDENTIALS = Join-Path $env:CLOUDSDK_CONFIG 'application_default_credentials.json'
```

Complete Google login/consent yourself. The named account must own the diagnostic
script and match `accountEmail`. The OAuth client's ID must match `oauthClientId`
and belong to the Cloud project associated with the script. `projectId` documents
that owner-verified association; it does not change a script's Cloud project.
Scopes come from the staging manifest plus `script.projects` and
`script.deployments.readonly`. Production OAuth scopes are unchanged.

The tool accepts only a regular, explicitly selected `authorized_user` credential
file outside the repository. It checks the client ID and verifies the signed-in
email with Google before upload/execution. Service accounts, external-account
configurations, endpoint overrides and automatic credential discovery are refused.
Restrict access to the private directory; credential contents are never printed.
Google Cloud CLI authorization may overwrite its ADC file, which is why this
example uses a dedicated `CLOUDSDK_CONFIG` directory.

Existing `.clasp-staging.json` files and old prepared bundles are not automatically
migrated. Create the new configuration and preserve/move old local evidence before
preparing a fresh bundle for the same staging script. The tool never deletes them.

## Upload and measure

From the repository root:

```powershell
npm run staging -- check
npm run staging -- push --confirm-staging
```

`check` is entirely local and prints the exact validated target/file list.
Before pushing, inspect it. **The content API replaces the
remote project's content. Never point this bundle at an existing application.**
In the diagnostic Apps Script editor, deploy as **API Executable**, accessible
only to yourself. Copy its deployment ID from **Deploy → Manage deployments**.
Then, in the same authorized PowerShell window:

```powershell
$env:FLINK_STAGING_DEPLOYMENT_ID = 'REPLACE_WITH_API_EXECUTABLE_DEPLOYMENT_ID'
npm run staging -- run --confirm-staging
```

The runner verifies bundle hashes and refuses changed/stale source or target. It
checks that the API deployment belongs to the configured staging script and has
`MYSELF` access, then
calls the fixed diagnostic function using owner-only `devMode: true` (latest saved
source). Upload responses must contain the exact expected source files.
The remote private test checks the exact script ID and refuses a configured
Master book. It verifies a PBKDF2 vector, measures exact-match lookups at 10 and
5,000 synthetic rows, trashes only the exact spreadsheet it created, and runs
the existing KDF calibration with synthetic inputs. Cleanup failure fails the
run. Measurements are stored in a new ignored `runtime-results-<uuid>.json` file
only after a complete, valid passing response. Errors, unfinished executions and
failed cleanup cannot produce passing evidence. HTTP errors are sanitized;
transport retries and redirects are disabled. A network timeout may occur after
a remote change: inspect the staging project before retrying a mutation.

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

- https://github.com/googleapis/google-auth-library-nodejs
- https://cloud.google.com/sdk/gcloud/reference/auth/application-default/login
- https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent
- https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run
- https://developers.google.com/apps-script/api/how-tos/execute
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/workspace/sheets/api/limits
- https://developers.google.com/apps-script/reference/cache/cache
- https://developers.google.com/apps-script/guides/html/communication
