# FLINK Time — Installation Guide

## Recommended: Automated Installer

The automated installer is intended for normal Google Workspace administrators. It removes the source-copying and manual Web App deployment steps.

### What the installer does

After the user grants Google's required management access, the installer:

1. verifies the signed-in Google Workspace identity;
2. creates a new **FLINK Time Master** Google Sheet owned by that user;
3. creates a new Apps Script project bound to the Sheet;
4. downloads exactly five production files from an immutable pinned Git commit;
5. injects only the dedicated Master Sheet ID and installation-owner bootstrap values;
6. uploads the five files with the official Apps Script API;
7. creates an immutable Apps Script version;
8. creates the Web App deployment;
9. reads the Web App URL returned by Google;
10. returns the Master Sheet, Employee, Admin, and Super Admin links;
11. opens Super Admin setup.

If installation fails before completion, the installer attempts to move the incomplete Master Sheet to Trash.

### What the user still approves

Google intentionally retains two security decisions:

1. **Apps Script API management access.** Google keeps API access to script projects disabled by default. The user opens Google's Apps Script settings and enables it once before the installer can create or deploy scripts.
2. **FLINK Time runtime authorization.** A newly created Apps Script project may still require the installation owner to grant its Drive/Sheets scopes. The installed Web App detects this first-run state with `ScriptApp.getAuthorizationInfo(FULL)` and, when required, shows **AUTHORIZE FLINK TIME** using Google's own authorization URL.

The installer does not and should not try to silently approve either Google security decision.

### Normal user steps

1. Open the organization's FLINK Time Installer URL.
2. Click **Open Google API setting**.
3. Enable **Google Apps Script API**.
4. Return to the installer.
5. Click **INSTALL FLINK TIME**.
6. Wait while Google creates and deploys the system.
7. The Super Admin page opens.
8. If shown, click **AUTHORIZE FLINK TIME**, approve Google's consent screen, then click **I HAVE AUTHORIZED — CONTINUE**.
9. Complete the guided setup.

No GitHub, npm, Node.js, Git, command line, source copying, setup key, or deployment-screen work is required.

## Deploy the organization installer once

This section is for the FLINK Time maintainer.

Create a standalone Apps Script project containing:

```
installer/
  Code.gs
  Index.html
  appsscript.json
```

Then:

1. Associate the installer with an appropriate standard Google Cloud project.
2. Enable the **Google Apps Script API** in that Cloud project.
3. Configure the OAuth consent screen appropriately for the organization.
4. Save the three installer files.
5. Deploy the installer as a Web App using its manifest:
   - access: organization domain;
   - execute as: user accessing the Web App.
6. Authorize the installer scopes.
7. Distribute the installer Web App URL.

The installer requires broader scopes because it creates and deploys Apps Script projects. Those scopes stay isolated from the installed FLINK Time runtime.

## Manual/template fallback

If the automated installer is unavailable:

1. Make a copy of the FLINK Time Master Sheet in **My Drive**.
2. Choose **FLINK Time → 1. Prepare Installation**.
3. Open **Extensions → Apps Script**.
4. Choose **Deploy → New deployment → Web app**.
5. Set **Execute as: Me**.
6. Set access to **users in your Google Workspace domain**.
7. Deploy.
8. Return to the Sheet and choose **FLINK Time → 3. Open FLINK Time**.
9. Open Super Admin and complete setup.

Do not deploy the production app as public **Anyone** access.

## Portal links

- **Employee:** `?view=user` — may be embedded in Google Sites.
- **Admin:** `?view=admin` — direct Web App access.
- **Super Admin:** `?view=superadmin` — direct Web App access.

Admin and Super Admin are intentionally not embeddable.
