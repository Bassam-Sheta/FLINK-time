# WP1 — session safety and request-cost verification

Worktree: `flink-time-wp1`, branch `wp1-session-boundaries`, baseline `9e6db78`.
The separate WP0 worktree is preserved. No production deployment has changed.
This branch requires explicit integration with the other work packages.

## Test-first fixes

Trust boundary: browser tokens select durable privileged Sheets records; cached
snapshots and row indexes can become stale under concurrent requests. Assets are
account identity, session revocation and workspace authorization. Abuse cases
exercise stale authorization, ambiguous keys and misdirected writes. Cache is
never durable revocation state; this package does not guarantee immediate
revocation or cancel requests already running.

- Cached revoked sessions were accepted; they are now rejected and evicted.
- A stale touch could update a revoked row and re-cache an active snapshot.
  Touches now re-read under the session writer's lock and return durable state.
- Single-session stale cache could survive five minutes after failed eviction.
  A new versioned one-minute namespace bounds this and ignores old cache entries.
  Application-checked deadlines also cover delayed cache writes, backend
  over-retention and the local fallback. User bundles use `U:v2:` as well.
- An explicit invalid absolute expiry fell back to a legacy timeout.
  It now fails closed. Expiry rejects the exact deadline.
- Malformed explicit epochs could become legacy epoch one; they now fail closed.
- Duplicate authentication keys selected the first row. Literal lookups now
  inspect two matches and reject ambiguity without transferring the table.
  Returned keys are rechecked to reject row shifts during a lookup.
- Housekeeping did not coordinate row deletion with session writers. Its session
  snapshot/purge now shares their lock, before unrelated cleanup/job logging.

## Offline evidence

The isolated VM fixture exercises the real SessionService, MasterRepository and
Flags against a sparse synthetic spreadsheet adapter. It rejects growing-table
reads and unprotected session writes. Cache TTL, failed removal, eviction,
backend outage, row shifts, lock refusal and flush failure are exercised.

| Validation scenario | Every mocked Sheet method | getValues | setValues |
| --- | ---: | ---: | ---: |
| Cold | 41 | 3 | 0 |
| Warm, inside touch interval | 0 | 0 | 0 |
| Cold after six minutes, with touch | 63 | 5 | 1 |

Counts are identical at 10 and 50,000 rows. Metadata/finder configuration methods
are included; these counts **must not** be represented as Google quota units.
Only the small fixed GlobalSettings table is fully read in these scenarios.

Verified offline on 2026-10-01:

- `npm test`: **299/299 passed**, including 24 new session-boundary tests.
- Full configured Chromium suite: **4/4 passed** against the local RPC mock.
  The pinned Playwright installation was reused from `flink-time-current` via
  `NODE_PATH`; no dependency install or upgrade was performed in this worktree.
- `Code.gs` JavaScript syntax and `git diff --check`: passed. Git reports only
  the repository's LF-to-CRLF conversion warnings.
- No live Google requests, deployment, push or merge. WP0's six-test browser
  suite is separate and is not included in these WP1 totals.

## Remaining WP1 gates

- Real Google cache/lock behavior and session maintenance lock duration.
- Full timer start/stop and weekly-list cost profiles: those still scan growing
  workspace tables and cannot honestly meet the size-independent target yet.
- Account/membership mutation concurrency outside these session boundaries.
- Privileged-action fresh authorization and audit completeness remain separate
  security gates; this package does not implement mandatory MFA or manager grants.
- PR integration with WP0 and eventual Google staging tests. Do not deploy this
  as proof of complete reliability, security or any fixed token-saving percentage.

## Official references

- [Lock acquisition, ownership, release and flush](https://developers.google.com/apps-script/reference/lock/lock)
- [TextFinder matching and iteration](https://developers.google.com/apps-script/reference/spreadsheet/text-finder)
