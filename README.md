# FLINK Time & Workforce Platform

Google Workspace-native time tracking and workforce management.

## Install FLINK Time

**Normal installers do not need npm, Node.js, Git, a command line, or a setup key.**

The intended distribution method is a copy of the FLINK Time Master Google Sheet with its bound Apps Script project.

1. Make your own copy of the FLINK Time Master Sheet in **My Drive**.
2. Open the copy and choose **FLINK Time → Prepare Installation**.
3. Choose **Extensions → Apps Script → Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Access: **users in your Google Workspace domain**
4. Return to the Sheet and choose **FLINK Time → Open FLINK Time**.
5. Open **Super Admin** and complete the guided setup.

The first setup step automatically verifies that the signed-in Google account owns the Master Sheet and is also the Web App deployment owner.

For screenshots, troubleshooting, and the maintainer/template-building flow, see **[docs/INSTALLATION.md](docs/INSTALLATION.md)**.

## Production application

Only these five files are deployed to Google Apps Script:

```
apps-script/
  Code.gs
  User.html
  Admin.html
  SuperAdmin.html
  appsscript.json
```

Portal rule:

- **Employee:** may be embedded in Google Sites.
- **Admin:** open directly from the Web App URL.
- **Super Admin:** open directly from the Web App URL.

## Repository folders

```
apps-script/       production application
tests/             automated regression/security/browser tests
docs/              installation, architecture, and security documentation
.github/workflows  GitHub CI
```

The test tooling is for developers and CI only. It is never deployed to Google Apps Script.

## Developers

Run the regression suite locally only when needed:

```bash
npm test
```

GitHub Actions runs the regression and browser tests for pull requests and changes to `main`.

Architecture and security details are in **[docs/SYSTEM_SPEC.md](docs/SYSTEM_SPEC.md)**.
