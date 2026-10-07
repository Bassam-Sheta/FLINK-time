/** Developer-only. Generated into an isolated API-executable staging project. */
function runStagingChecks_() {
  if (ScriptApp.getScriptId() !== '__STAGING_SCRIPT_ID__') {
    throw new Error('Staging target mismatch');
  }
  if (PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID') ||
      (typeof INSTALLER_BOOTSTRAP !== 'undefined' &&
       INSTALLER_BOOTSTRAP.masterSpreadsheetId !== '__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__')) {
    throw new Error('Application storage must be absent in this diagnostic project');
  }
  const expected = 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43';
  if (SecurityService.pbkdf2Sync('password', 'salt', 2, 32) !== expected) {
    throw new Error('PBKDF2 runtime vector failed');
  }
  const report = {
    environment: 'STAGING', suite: 'runtime-primitives',
    measuredAtUTC: new Date().toISOString(),
    cryptoVectorPassed: true, cleanedUp: false, sheetLookups: []
  };
  const title = 'FLINK-STAGING-DIAGNOSTIC-' + Utilities.getUuid();
  const book = SpreadsheetApp.create(title);
  try {
    const sheet = book.getSheets()[0];
    sheet.deleteColumns(3, sheet.getMaxColumns() - 2);
    for (const count of [10, 5000]) {
      if (sheet.getMaxRows() < count + 1) sheet.insertRowsAfter(sheet.getMaxRows(), count + 1 - sheet.getMaxRows());
      const rows = [['Key', 'Value']];
      for (let i = 0; i < count; i++) rows.push(['SYNTHETIC-' + i, i]);
      sheet.getRange(1, 1, rows.length, 2).setValues(rows);
      SpreadsheetApp.flush();
      const key = 'SYNTHETIC-' + (count - 1);
      const started = Date.now();
      const match = sheet.getRange(2, 1, count, 1).createTextFinder(key)
        .matchEntireCell(true).matchCase(true).useRegularExpression(false).findNext();
      const value = match ? sheet.getRange(match.getRow(), 1, 1, 2).getValues()[0] : [];
      const matched = value[0] === key && value[1] === count - 1;
      if (!matched) throw new Error('Sheet lookup failed');
      report.sheetLookups.push({ rows: count, elapsedMs: Date.now() - started, matched: matched });
    }
  } finally {
    // Only the exact book created by this invocation; never scan/delete folders.
    const file = DriveApp.getFileById(book.getId());
    if (file.getName() !== title) throw new Error('Diagnostic cleanup ownership mismatch');
    file.setTrashed(true);
    report.cleanedUp = true;
  }
  // Existing production implementation, synthetic inputs; settings are not changed.
  report.kdf = benchmarkPasswordKdf_();
  report.coverage = 'PBKDF2 and Sheet primitives only; not portal, app mutation, trigger or load acceptance';
  return report;
}
