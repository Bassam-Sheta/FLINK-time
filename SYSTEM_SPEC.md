# FLINK Time — Final Canonical System Specification

## Final topology

```
Google Sites / Direct Web App Access
  ├── Employee page   -> Apps Script /exec?view=user        (Google Sites embed allowed)
  ├── Admin page      -> Apps Script /exec?view=admin       (direct access only)
  └── Super Admin page-> Apps Script /exec?view=superadmin  (direct access only)
                              |
                              v
                           Code.gs
                              |
             +----------------+----------------+
             |                |                |
        Master Sheet     Workspace Sheets   Google Drive
                                             + Script Properties
```

## Deployable source contract

The production application intentionally has only:
1. `Code.gs` — all backend/API/security/data/business/admin logic.
2. `User.html` — employee Google Sites embed.
3. `Admin.html` — Admin/Manager Google Sites embed.
4. `SuperAdmin.html` — Super Admin Google Sites embed.
5. `appsscript.json` — Apps Script manifest.

No other `.gs` file is required for deployment.

## Role surfaces

### USER portal
Timer, My Time, self-scoped Reports, Account.

### ADMIN portal
Manager workspace, assigned-workspace Reports, Account.

### SUPER_ADMIN portal
Super Admin control center, Manager workspace, Reports, Account, first-run setup.

Client-side portal separation is a usability layer only. Server-side `ACTION_PERMISSIONS`, session validation, workspace ACLs, and role checks remain the security authority.

## Authentication
- Browser RPC allowlist: only `handleClientRequest` is the application RPC bridge; internal routing/dispatcher/setup/trigger functions end in `_` and are not callable through `google.script.run`.
- Google Workspace domain-restricted web app.
- Server-observed Google Workspace email must match the FLINK account email.
- Password hashing, failed-login throttling/lockout, session idle/absolute expiry, password-version invalidation, forced password change, and MFA rules remain in `Code.gs`.
- High-risk Super Admin mutations require a short-lived step-up grant created only after fresh password + TOTP verification. Step-up rotates the authenticated session and is bound to the replacement SessionID.
- The sole root SUPER_ADMIN is a protected trust anchor: generic CRUD cannot demote it, deactivate it, re-bind its Google Workspace identity, or disable its MFA.

## Privileged storage boundary
- The Master Control Sheet, workspace Sheets, backup files, and Apps Script project are privileged infrastructure.
- Ordinary users must not receive direct Editor access to those resources; direct edit access bypasses application RBAC.
- Production should use a dedicated deployment/automation identity where possible.
- Admin and Super Admin portals are direct Web App pages and are not framed with ALLOWALL.

## Data integrity
- UTC storage.
- Workspace-local timezone/date/week interpretation.
- One active timer per user.
- Idempotent timer operations.
- Optimistic concurrency for time-entry mutation.
- Immutable timesheet submission membership.
- Explicit timesheet state machine.
- Canonical rollup rebuild from raw TimeEntries.
- Audit records are spreadsheet-canonicalized before HMAC calculation.
- Daily external checkpoints anchor the Master and each active workspace audit chain in Script Properties.
- Checkpoints include a full-prefix snapshot HMAC so legacy audit fields become sealed against later mutation.
- Privileged mutations require a successful pre-action audit write; if the security audit trail is unavailable, the mutation is blocked.

## Repository policy
The active source is source-first. Compiled executables, temporary packaging output, legacy desktop clients, and duplicate Apps Script modules are not committed.
