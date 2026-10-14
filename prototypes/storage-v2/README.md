# Archived storage experiment — not production

These four modules and their tests are disconnected from the deployed application.
They are retained as research, not as a supported storage implementation.

Known limitations include eviction-prone cache locking, part-bound retry IDs,
stale capacity counters and incomplete authorization/audit recovery integration.
Passing their mocked tests does **not** establish production safety.

`npm test` excludes this archive. To work on the experiment explicitly, run
`npm run test:prototypes`. Do not deploy these files or import them into `Code.gs`.

Historical review: `docs/CURRENT_SECURITY_REVIEW.md` refers to their former
`storage-v2/` paths; the contents are preserved here.
