# Staging the v2 app

`scripts/staging.js --app v2` prepares and uploads `apps-script-v2/` to an **empty, owner-approved staging Apps Script project**. It follows the same safety rules as the old app's staging tool (`docs/STAGING_TESTS.md`): only a `STAGING` target, never the production script, nothing uploaded without `--confirm-staging`, and a prepared bundle that must still match its sources.

## What is uploaded

- `appsscript.json` first: `apps-script-v2/appsscript.template.json` with `{{TURSO_ORIGIN}}` replaced by the staging database's origin, which then is the only address `UrlFetchApp` may reach. Nothing else is changed; in particular there is no `executionApi`.
- Then every file of `apps-script-v2/files.json`, in that order (Apps Script loads files in project order, and `Portal.html` is last).

No diagnostics file is added: the v2 app has no remote runtime check. After a push, the owner runs `runMigrations` from the Apps Script editor (ticket T1.13), and the setup page at `/exec?view=setup` the first time.

## One-time set-up

1. Create an empty Apps Script project for staging and a separate staging Turso database. Neither may hold anything that matters.
2. Copy `scripts/staging.v2.config.example.json` to `.staging.v2.config.json` at the repository root (it is git-ignored) and fill in every field. `tursoOrigin` is the database address as `https://host`, with no path and no trailing slash. Never use the production script id.
3. Authorize as described in `docs/STAGING_TESTS.md` (the scopes come from `node scripts/staging.js --app v2 scopes`, and `FLINK_STAGING_CREDENTIALS` points to the authorized-user file outside the repository).

## Commands

```bash
npm run staging -- --app v2 doctor
npm run staging -- --app v2 prepare
npm run staging -- --app v2 check
npm run staging -- --app v2 push --confirm-staging
```

`doctor` makes no Google call. `prepare` writes `.staging/v2-<scriptId>/` and refuses to overwrite an earlier one. `check` fails if a source file, the configuration or the target changed since `prepare`. `push` uploads and verifies the files. `run` is refused for v2.

The old app's commands are unchanged: leave out `--app` (or pass `--app v1`) and it uses `.staging.config.json` and `.staging/<scriptId>/` exactly as before.
