# FLINK Time & Workforce Platform

FLINK Time is a Google Workspace-native time tracking and workforce management application.

## Source layout

Only the modern source-first application is kept in the active repository:

```
apps-script/
  Code.gs
  Security.gs
  Data.gs
  Business.gs
  Admin.gs
  App.html
  appsscript.json

tests/
SYSTEM_SPEC.md
README.md
package.json
.github/workflows/stabilization-tests.yml
```

The old Windows portable tracker, packager, standalone desktop Admin Controller, bundled executables, launchers, and legacy release-package tree are retired from the active branch. They are not part of the supported stabilized architecture.

## Architecture

- Google Sites or the direct Apps Script web app provides the browser UI.
- One Apps Script deployment is the only API/backend.
- Google Sheets stores master/workspace data.
- Google Drive stores managed backups/reports.
- Script Properties stores application secrets.
- USER, ADMIN, and SUPER_ADMIN roles share the same authenticated backend and UI codebase.
- Browser sessions are additionally bound to the server-observed Google Workspace email.

## Deploy

1. Create the Master Control Google Sheet.
2. Open Extensions > Apps Script.
3. Create the five `.gs` files and one HTML file from `apps-script/`.
4. Enable the manifest and copy `apps-script/appsscript.json`.
5. Run `initializeInstallation()` once from the Apps Script editor and retain the one-time setup key.
6. Deploy as a Web App:
   - Execute as: **Me**
   - Access: **Anyone in your Google Workspace domain**
7. Open the `/exec` URL and complete Setup Step 1 using the one-time key.
8. Embed the same web-app URL into the appropriate Google Sites pages if desired.

Do not deploy this production build as public `Anyone` access.

## Test

```bash
npm test
```

The GitHub Actions stabilization workflow runs the same regression suite for the stabilization pull request.
