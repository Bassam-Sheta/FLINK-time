# FLINK Time — Installation Guide

This guide is for the person installing FLINK Time for a company.

You do **not** need npm, Node.js, Git, a command line, or a one-time setup key.

## Recommended installation: Master Sheet copy

### 1. Make your own copy

Use the FLINK Time Master Google Sheet template and make a copy in **My Drive**.

The first installation must start from a Sheet that your Google account owns. Do not move the Sheet into a Shared Drive until initial setup is complete.

### 2. Prepare FLINK Time

Open the copied Sheet.

From the menu choose:

**FLINK Time → 1. Prepare Installation**

Google may ask you to authorize the script. Approve the requested permissions for the company account that will own and operate FLINK Time.

The preparation step:

- binds the Apps Script project to this Master Sheet;
- records the installation owner;
- creates/repairs the required Master Sheet tabs;
- initializes the server-side cryptographic secret;
- does **not** create users or passwords.

### 3. Deploy the Web App

In the Sheet choose **Extensions → Apps Script**.

Then:

1. Click **Deploy → New deployment**.
2. Choose **Web app**.
3. Set **Execute as: Me**.
4. Set access to **users in your Google Workspace domain**.
5. Click **Deploy**.
6. Complete Google's authorization prompt if shown.

Do not deploy the production system as public **Anyone** access.

### 4. Open FLINK Time

Return to the Master Sheet.

Choose:

**FLINK Time → 3. Open FLINK Time**

Open the **Super Admin** link.

Use the **same Google Workspace account** that:

- owns the copied Master Sheet; and
- deployed the Web App.

### 5. Complete the guided setup

The Super Admin page walks through the setup in the GUI.

It creates/configures:

1. root Super Admin;
2. company settings;
3. first workspace;
4. workspace admin;
5. initial employee;
6. client/project;
7. time rules;
8. reporting/alerts;
9. system health verification.

Optional Admin/Employee creation steps may be skipped and completed later from the Super Admin console.

### 6. Use the correct portal links

After setup:

- **Employee**: `?view=user` — may be embedded in Google Sites.
- **Admin**: `?view=admin` — open directly.
- **Super Admin**: `?view=superadmin` — open directly.

Admin and Super Admin are intentionally not embeddable.

## If something goes wrong

**FLINK Time menu is missing**

Reload the Google Sheet. The menu is added when the bound Apps Script project opens with the Sheet.

**"Only the Google account that owns this Master Sheet can prepare FLINK Time"**

Make sure you are signed in with the owner account and that the Sheet is a copy in My Drive.

**"FLINK Time is not deployed yet"**

Complete Step 3 above, then reopen **FLINK Time → Open FLINK Time**.

**"First-time setup must be completed by..."**

The account that prepared the Sheet and the account that deployed the Web App do not match. Use the same company account for both.

## Maintainer: building the template from this repository

This section is only for the person creating the distributable Master Sheet template.

1. Create/open the Master Google Sheet.
2. Open **Extensions → Apps Script**.
3. Copy the five files from `apps-script/` into the bound Apps Script project:
   - `Code.gs`
   - `User.html`
   - `Admin.html`
   - `SuperAdmin.html`
   - `appsscript.json`
4. Save the Apps Script project.
5. Reload the Sheet.
6. Confirm the **FLINK Time** menu appears.
7. Keep this Sheet as the controlled template source.

The `tests/`, npm files, GitHub workflow, and `docs/` folder are engineering assets and are not copied into the production Apps Script project.
