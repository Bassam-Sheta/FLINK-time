# FLINK Time — Canonical System Specification

## 1. Supported topology

The production system is one Google Workspace-native application:

```
Google Sites / Browser
        |
        v
Google Apps Script Web App
        |
        +--> Master Sheet
        +--> Workspace Sheets
        +--> Google Drive
        +--> Script Properties
```

There is no supported portable Windows tracker, client packager, second REST backend, or standalone desktop Admin Controller in the stabilized source tree.

## 2. Deployable source files

The complete deployable application is intentionally consolidated to seven files:

- `Code.gs` — constants, errors, validation, HTTP/API gateway, dispatcher.
- `Security.gs` — Google identity binding, password/MFA, sessions, RBAC, tracking policy.
- `Data.gs` — Drive access, repositories, workspace routing/lifecycle, timezone data services.
- `Business.gs` — clients/projects/tasks/tags, timers, time entries, timesheets, approvals, reports, rollups, dashboards.
- `Admin.gs` — user lifecycle, Admin requests, setup, integrity, jobs, backups/audit, export/migration.
- `App.html` — single-page USER/ADMIN/SUPER_ADMIN GUI.
- `appsscript.json` — Apps Script manifest.

## 3. Identity and authentication

Production deployment is domain-restricted and executes as the deploying account so staff do not need direct spreadsheet permissions.

For WEB sessions, FLINK Time reads the server-observed Google Workspace email using `Session.getActiveUser().getEmail()`. That email must match the FLINK account Email before a WEB session is issued or accepted.

Authentication also includes password verification, failed-login throttling/lockout, optional TOTP MFA, idle timeout, absolute timeout, password-version/session revocation, and forced-password-change rules.

## 4. Roles

- `USER` — own timer, own entries, own weekly timesheet, self-scoped reports, account/security.
- `ADMIN` — operational management for assigned workspaces only; maximum three active workspaces; submits lifecycle requests rather than executing Super Admin-only mutations.
- `SUPER_ADMIN` — global governance and lifecycle control.

## 5. Data model

- UTC is the storage time model.
- Workspace timezone determines business date/week boundaries and local display.
- Workspace operational data remains physically isolated by workspace spreadsheet.
- Master control stores identity, credentials metadata, workspace registry/access, sessions, requests, global configuration and audit/control data.
- Passwords are stored as salted one-way hashes, never reversible plaintext/encryption.

## 6. Time integrity

- One active timer per user across active accessible workspaces.
- Timer start/stop operations support idempotency.
- Time-entry updates/deletes require optimistic-concurrency versions.
- Submitted/approved entries are locked against ordinary mutation.
- Timesheet submission captures immutable membership snapshots.
- Approval/rejection/reopen follow the explicit state machine.
- Rollups can be rebuilt canonically from raw TimeEntries.

## 7. Browser identity-binding requirement

The deployment must remain restricted to the Google Workspace domain. FLINK Time requires the server-observed Google Workspace email to match the FLINK account Email. A mismatched or missing Google identity fails authentication or revokes an existing WEB session.

## 8. Repository policy

The active branch is source-first. Compiled `.exe` artifacts, build outputs, temporary packaging folders, and legacy launchers are not committed to the stabilized source tree. If a desktop client is ever reintroduced, its real source and reproducible build pipeline must be reviewed separately before binaries are published as release artifacts.
