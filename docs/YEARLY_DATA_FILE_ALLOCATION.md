# Yearly Data-file allocation foundation — 2026-10-12

Branch `wp9-yearly-data-rotation`, based on published staging readiness `92559ab`.

## Delivered scope

Owner/editor-only allocation in the existing production `Code.gs`; no extra
production file, external service, OAuth scope, browser action or feature switch.
**Automatic application rotation is not activated by this package.**

- Each workspace's current registered spreadsheet is the Core cohort identity.
  A bounded additional `DataFileRegistry` tab records at most 512 physical files.
  Year and part are stored with both workspace and Core file IDs, not alone.
- Separate Data spreadsheets contain the growing-table schemas and a physical
  `DataFileInfo` identity marker. Projects, accounts and ActiveTimers are not moved.
- `prepareYearlyDataFile_(workspaceId, year, tabName, additionalRows)` requires the
  installation owner, rechecks owner and ACTIVE workspace inside ScriptLock, and
  accepts 1-250 pending rows for a declared Data tab and year 1970-9999.
- Capacity uses every allocated grid, including empty/unknown tabs, plus pending
  row allocation. A file reaching **7,000,000 cells** is not selected for that
  allocation. Another actual spreadsheet is created with the next part number;
  old files remain registered and untouched. Registry growth is also checked
  against Core capacity and fails closed when the Core cannot accommodate it.
- Historical `resolve(location)` is owner-only and validates the registered
  workspace/Core/year/part/file tuple against the physical marker and full schema.
  Cross-workspace, stale-Core, duplicate and broken part locations fail closed.
- Files must be owned by the installation owner with PRIVATE sharing and no extra
  editors or viewers. Unavailable files and unverifiable permissions fail closed;
  the allocator never automatically revokes permissions or moves files into a
  potentially shared folder.

## Durable transitions and failures

1. Flush attributable creation intent and persist PREPARING before Drive creation.
2. Register the created ID and flush before initializing that new file.
3. Verify its identity, privacy and schema; audit/flush READY intent, write READY,
   and require completion auditing.
4. Audit projected allocation, grow only the selected grid, flush and require
   completion before returning its location. Release ScriptLock even on failure.

An interrupted create with no registered file ID is intentionally **not** retried
automatically: the owner must inspect the operation ID/name and its audit trail.
Registered incomplete files can be initialized on retry after verifying ownership
and known metadata/headers; corrupt/foreign content stops for review. Applied writes
and allocations remain after uncertain completion or flush. No rollback, deletion
of referenced files or automatic repair of incomplete audit pairs is claimed.

The allocator prepares capacity; it **does not reserve rows**. Any eventual writer
must recheck capacity and persist its immutable route under the same writer lock,
not use a prepared file ID as authorization to write later.

## Activation gates — still required

Do not prepare files in production merely to test this component. Use an explicitly
approved synthetic installation; live execution still needs Google owner consent.

The next integration changes must implement and test together:

1. Durable immutable record locations and idempotency that survive rotation,
   backdated entries and edits changing dates. Timer start/stop must preserve the
   same logical record identity across year boundaries and retries.
2. Repository routing for reads/updates/deletes and cross-file reports, rollups,
   timesheet membership, approvals and audit chains. There must be no implicit
   fallback that reads or writes the newest file for a historical record.
3. Multi-file backup/restore manifests and retained file sets. The current backup
   service copies one workspace spreadsheet and does **not** protect data in these
   new files. Restore changes the Core cohort and must not silently join old files.
4. An audited, bounded migration and an explicit safe rollout path for existing
   single-file workspaces, plus whole-request capacity metrics and bounded jobs.

Current repositories are deliberately unchanged while these gates remain open.
The allocation foundation must not be described as completed live yearly rotation.

## Verification

Full unit suite: **550/550 pass** (`node --test tests/*.test.js`), including
sixteen new allocator tests. Existing mocked Chromium suite: **14/14 pass**;
allocator behavior is tested at the service boundary, not through browser RPC.
Native npm audit: **zero findings**. Diff checks pass.

Behavioral tests use real allocator logic with synthetic Sheets, Drive, lock and
audit boundaries. They cover distinct years/files, pending row growth, exact 70%
allocation, immutable historical resolution, corrupt/bounded registry state,
privacy/ownership, owner/status changes while queued, audit failures, uncertain
creation, interrupted initialization, row-allocation failures and flush failures.

No live Google file, deployment or migration was created or changed.

Official references:

- [Drive file sharing and ownership](https://developers.google.com/apps-script/reference/drive/file)
  (`getOwner`, `getSharingAccess`, `getEditors`, `getViewers`). Lack of edit access
  can produce empty permission arrays, so ownership is checked separately.
- [Google Drive file limits](https://support.google.com/drive/answer/37603?hl=en)
  lists Sheets' ten-million-cell limit. Seven million is the application's stricter
  rotation policy, not a Google limit. Live quotas and permissions still need validation.
