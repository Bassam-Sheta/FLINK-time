# FLINK Time — Final Canonical System Specification

## Final topology

```
Google Sites
  ├── Employee page   -> Apps Script /exec?view=user
  ├── Admin page      -> Apps Script /exec?view=admin
  └── Super Admin page-> Apps Script /exec?view=superadmin
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
- Google Workspace domain-restricted web app.
- Server-observed Google Workspace email must match the FLINK account email.
- Password hashing, failed-login throttling/lockout, session idle/absolute expiry, password-version invalidation, forced password change, and MFA rules remain in `Code.gs`.

## Data integrity
- UTC storage.
- Workspace-local timezone/date/week interpretation.
- One active timer per user.
- Idempotent timer operations.
- Optimistic concurrency for time-entry mutation.
- Immutable timesheet submission membership.
- Explicit timesheet state machine.
- Canonical rollup rebuild from raw TimeEntries.

## Repository policy
The active source is source-first. Compiled executables, temporary packaging output, legacy desktop clients, and duplicate Apps Script modules are not committed.
