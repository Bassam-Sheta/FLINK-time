# FLINK Time — instructions for Claude

This repo is moving FLINK Time from Google Sheets to Turso. The new app is being built in `apps-script-v2/`; the old app in `apps-script/` stays untouched until launch.

## Read first

1. `docs/v2/BUILD_SPEC.md` — exactly what to build. Sections 0–3 before any code; then section 12, one ticket at a time.
2. `docs/v2/PLAN.md` — why. If it disagrees with the spec, the spec wins; note the difference in `docs/v2/questions.md`.
3. `docs/v2/phase0-results.md` — measured Turso and Apps Script behaviour. Don't rely on platform behaviour that isn't recorded here.

## Commands

```bash
npm run test:v2      # new app (Node 24, node:sqlite); must be green before every commit
npm test             # old app; must stay green
```

## Rules

- Never edit `apps-script/`, `installer/`, `storage-v2/` or top-level `tests/*.test.js` (until ticket T7.4).
- One ticket per commit. A ticket is done only when its tests pass and its "Done when" list holds.
- Tests first for every rule, permission and SQL statement. Tests run against `tests/v2/helpers/fake-turso.js`; nothing needs Google or Turso.
- `.gs` files only define things at top level (`var Name = {...}`, `function name_() {}`); no top-level calls.
- Only built-in Apps Script services at runtime. No new npm dependencies unless a ticket says so.
- No secrets, tokens, sheet ids or deployment URLs in code, tests, fixtures or commits.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with dynamic data in `Portal.html`.
- User-role responses are built from field allowlists; rates, costs and money never reach the user role.
- Integer arguments in `fake-turso.js` are bound as `BigInt` (see spec section 10), or duration CHECKs fail.
- If a ticket is ambiguous or a spec limit looks wrong: write the question at the top of `docs/v2/questions.md` and stop. Don't improvise.
