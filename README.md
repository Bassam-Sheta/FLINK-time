# FLINK Time & Workforce Platform

Final Google Workspace-native architecture.

## Deployable application

```
apps-script/
  Code.gs
  User.html
  Admin.html
  SuperAdmin.html
  appsscript.json
```

That is the complete deployable application:
- **1 Google Apps Script backend:** `Code.gs`
- **3 Google Sites embed pages:** `User.html`, `Admin.html`, `SuperAdmin.html`
- **1 Apps Script manifest:** `appsscript.json`

No Windows EXEs, packagers, launchers, standalone desktop controllers, or `RELEASE_PACKAGE/` tree are part of the supported system.

## Google Sites embed URLs

Deploy the Apps Script project once as a Web App. Use the same `/exec` deployment with these query strings:

- Employee portal: `<WEB_APP_EXEC_URL>?view=user`
- Admin / Manager portal: `<WEB_APP_EXEC_URL>?view=admin`
- Super Admin portal: `<WEB_APP_EXEC_URL>?view=superadmin`

Embed each URL on the matching Google Sites page.

## Access model

- `User.html` accepts USER, ADMIN, and SUPER_ADMIN accounts but exposes the employee-facing Timer / My Time / Reports / Account navigation.
- `Admin.html` accepts ADMIN and SUPER_ADMIN accounts and exposes Manager / Reports / Account.
- `SuperAdmin.html` accepts only SUPER_ADMIN and exposes Admin Console / Manager / Reports / Account.
- Server-side RBAC remains authoritative for every API action.
- Browser RPC is deliberately limited to `handleClientRequest`; internal router, dispatcher, setup, and scheduled functions are private server functions ending in `_`.
- WEB sessions are bound to the server-observed Google Workspace email.

## Deployment

1. Create/open the Master Control Google Sheet.
2. Open **Extensions → Apps Script**.
3. Create `Code.gs`, `User.html`, `Admin.html`, and `SuperAdmin.html` from `apps-script/`.
4. Enable the manifest and paste `appsscript.json`.
5. Run the private server function `initializeInstallation_()` once from the Apps Script editor as the deployment owner and save the one-time setup key. The trailing underscore keeps it unavailable to browser RPC calls.
6. Deploy as a Web App:
   - Execute as: **Me**
   - Access: **Anyone in your Google Workspace domain**
7. Open `?view=superadmin` first and complete the setup wizard.
8. Embed the three role URLs in Google Sites.

Do not deploy this production build as public `Anyone` access.

## Test

```bash
npm test
```
