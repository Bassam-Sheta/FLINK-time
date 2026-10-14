'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/yearly-entry-fixture');
const root={userId:'ROOT',role:'SUPER_ADMIN'};
const worker={userId:'U1',role:'USER'};

function populated() {
  const fx=fixture();fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('NEW'),worker);
  fx.repo.createTimeEntry('W1',fx.entry('OLD','2025-12-31T23:00:00.000Z'),worker);
  fx.lock.tryLock();
  for(const name of ['DailyRollups','WeeklyRollups','MonthlyRollups']) {
    fx.core.getSheetByName(name).appendRow(Array.from(fx.context.WORKSPACE_SCHEMA[name],key=>key==='TotalSeconds'?7200:''));
  }
  fx.lock.releaseLock();
  fx.backup=()=>fx.context.BackupService.createBackup(root,'W1');
  fx.restore=id=>fx.context.BackupService.restoreBackup(root,'W1',id,'SYNTHETIC-PASSWORD');
  return fx;
}

test('workspace backup contains isolated copies of every Data file and authenticates each one',()=>{
  const fx=populated();const backup=fx.backup();
  assert.equal(fx.controls.copies,3,'Core and both yearly files');
  const stored=JSON.parse(fx.backups[0].ChecksumMetadata);
  assert.equal(stored.dataFiles.length,2);
  assert.equal(fx.context.BackupService.validateBackup(root,'W1',backup.backupId).valid,true);
  const snapshot=fx.books.get(backup.backupFileId);
  assert.equal(snapshot.getSheetByName('EntryStorageActivation').values[1][1],backup.backupFileId);
  for(const row of snapshot.getSheetByName('DataFileRegistry').values.slice(1)) {
    assert.equal(row[1],backup.backupFileId);
    assert.ok(stored.dataFiles.some(item=>item.fileId===row[4]));
    assert.notEqual(row[4],fx.repo.getEntry('W1',row[2]===2026?'NEW':'OLD')._rowIndex.spreadsheetId);
  }
  const tab=fx.books.get(stored.dataFiles[0].fileId).getSheetByName('TimeEntries');
  tab.values[1][fx.context.WORKSPACE_SCHEMA.TimeEntries.indexOf('DurationSeconds')]=999;
  assert.throws(()=>fx.context.BackupService.validateBackup(root,'W1',backup.backupId),error=>error.code==='CRYPTO_FAILURE');
});

test('restore copies the whole set and rewrites all references before switching the Core',()=>{
  const fx=populated();const backup=fx.backup();const originalCore=fx.workspace.SpreadsheetID;
  const originalIds=fx.repo.listTimeEntries('W1').map(row=>row._rowIndex.spreadsheetId);
  const stored=JSON.parse(fx.backups[0].ChecksumMetadata);
  fx.repo.updateTimeEntry('W1','NEW',{Description:'after snapshot'},worker);
  const result=fx.restore(backup.backupId);
  assert.notEqual(result.restoredSpreadsheetId,originalCore);
  assert.notEqual(result.restoredSpreadsheetId,backup.backupFileId);
  const activation=fx.books.get(result.restoredSpreadsheetId).getSheetByName('EntryStorageActivation');
  assert.equal(activation.values[1][1],result.restoredSpreadsheetId);
  assert.equal(activation.values[1][6],'COMPLETE');
  assert.equal(fx.repo.getEntry('W1','NEW').Description,'');
  for(const row of fx.repo.listTimeEntries('W1')) {
    assert.equal(row._rowIndex.coreSpreadsheetId,result.restoredSpreadsheetId);
    assert.ok(!originalIds.includes(row._rowIndex.spreadsheetId));
    assert.ok(!stored.dataFiles.some(item=>item.fileId===row._rowIndex.spreadsheetId));
  }
  assert.equal(fx.files.get(originalCore).trashed,false);
  assert.equal(fx.controls.locked,false);
});

test('failed Data copy cannot publish an AVAILABLE partial backup',()=>{
  const fx=populated();fx.controls.failCopy=2;
  assert.throws(()=>fx.backup());
  assert.equal(fx.backups.filter(row=>row.Status==='AVAILABLE').length,0);
  assert.equal(fx.controls.locked,false);
  assert.equal([...fx.files.values()].some(file=>file.trashed),false);
});

test('missing Data files and replaced manifest references are rejected before restore pointer changes',()=>{
  for(const tamper of ['missing','reference']) {
    const fx=populated();const backup=fx.backup();const manifest=JSON.parse(fx.backups[0].ChecksumMetadata);
    if(tamper==='missing')fx.files.get(manifest.dataFiles[0].fileId).trashed=true;
    else {manifest.dataFiles[0].fileId=fx.repo.getEntry('W1','NEW')._rowIndex.spreadsheetId;fx.backups[0].ChecksumMetadata=JSON.stringify(manifest);}
    assert.throws(()=>fx.restore(backup.backupId));
    assert.equal(fx.workspace.SpreadsheetID,'CORE-1');assert.equal(fx.workspace.Status,'ACTIVE');
  }
});

test('revocation failure and unconfirmed rollback retain all candidate files',()=>{
  const fx=populated();const backup=fx.backup();fx.controls.failRevoke=true;
  const update=fx.context.MasterRepository.updateWorkspace;
  fx.context.MasterRepository.updateWorkspace=(id,updates)=>{
    if(updates.SpreadsheetID==='CORE-1')throw new Error('Rollback unavailable');
    return update(id,updates);
  };
  assert.throws(()=>fx.restore(backup.backupId),error=>error.details.recoveryRequired===true);
  const current=fx.books.get(fx.workspace.SpreadsheetID);
  assert.equal(fx.files.get(current.getId()).trashed,false);
  for(const row of current.getSheetByName('DataFileRegistry').values.slice(1))assert.equal(fx.files.get(row[4]).trashed,false);
});

test('backup retention treats each snapshot as a complete set',()=>{
  const fx=populated();const oldest=fx.backup();fx.backup();fx.backup();fx.backup();
  fx.backups[0].CreatedAt='2020-01-01T00:00:00Z';
  const manifest=JSON.parse(fx.backups[0].ChecksumMetadata);
  fx.context.BackupService.pruneOldBackups(root,{maxRetained:3,minRetained:3});
  assert.equal(fx.files.get(oldest.backupFileId).trashed,true);
  for(const file of manifest.dataFiles)assert.equal(fx.files.get(file.fileId).trashed,true);
  assert.equal(fx.files.get(fx.repo.getEntry('W1','NEW')._rowIndex.spreadsheetId).trashed,false);
});

test('failed backup audit never marks a partial or unverified snapshot AVAILABLE',()=>{
  for(const action of ['FILE_SET_COPY_INTENT','FILE_SET_REBASE_COMPLETED','BACKUP_SET_VERIFIED']) {
    const fx=populated();fx.controls.failAudit=action;
    assert.throws(()=>fx.backup(),error=>error.code==='CRYPTO_FAILURE');
    assert.equal(fx.backups.some(row=>row.Status==='AVAILABLE'),false);
    assert.equal(fx.controls.locked,false);
    assert.equal([...fx.files.values()].some(file=>file.trashed),false);
  }
});

test('restore checks copied Data content and Core audit integrity before changing the pointer',()=>{
  for(const mode of ['copy','audit']) {
    const fx=populated();
    if(mode==='audit') {
      fx.lock.tryLock();fx.core.getSheetByName('AuditLog').appendRow(Array.from(fx.context.WORKSPACE_SCHEMA.AuditLog,key=>({AuditID:'BROKEN',TimestampUTC:'2026-01-01T00:00:00Z',PreviousHash:'NOT-THE-PREVIOUS-HASH',RecordHash:'BROKEN'})[key]||''));fx.lock.releaseLock();
    }
    const backup=fx.backup();
    if(mode==='copy') fx.controls.onCopy=book=>{if(book.getSheetByName('DataFileInfo'))book.getSheetByName('TimeEntries').values[1][0]='ALTERED';};
    assert.throws(()=>fx.restore(backup.backupId),error=>error.code==='CRYPTO_FAILURE');
    assert.equal(fx.workspace.SpreadsheetID,'CORE-1');assert.equal(fx.workspace.Status,'ACTIVE');
  }
});

test('restore completion failure rolls back the entire routing policy and preserves isolated copies',()=>{
  const fx=populated();const backup=fx.backup();fx.controls.failAudit='RESTORE_COMPLETED';
  assert.throws(()=>fx.restore(backup.backupId),error=>error.code==='CRYPTO_FAILURE');
  assert.equal(fx.workspace.SpreadsheetID,'CORE-1');assert.equal(fx.workspace.PartitionPolicy,'YEARLY_ENTRIES_V1');
  assert.equal(fx.repo.listTimeEntries('W1').length,2);
  assert.equal([...fx.files.values()].some(file=>file.trashed),false);
});

test('restoring a legacy snapshot over yearly storage restores the legacy policy as well',()=>{
  const fx=fixture();
  const legacy=fx.context.BackupService.createBackup(root,'W1');fx.activate();fx.repo.createTimeEntry('W1',fx.entry('LATER'),worker);
  const oldData=fx.repo.getEntry('W1','LATER')._rowIndex.spreadsheetId;
  fx.context.BackupService.restoreBackup(root,'W1',legacy.backupId,'SYNTHETIC-PASSWORD');
  assert.equal(fx.workspace.PartitionPolicy,'');assert.equal(fx.repo.listTimeEntries('W1').length,0);
  assert.equal(fx.files.get(oldData).trashed,false);
  assert.ok(fx.backups.some(row=>JSON.parse(row.ChecksumMetadata).format==='YEARLY_ENTRIES_V1'),'pre-restore safety snapshot includes yearly data');
});

test('signed retention references cannot delete a snapshot still used by any workspace',()=>{
  const fx=populated();fx.backup();const record=fx.backups[0];
  fx.context.MasterRepository.listWorkspaces=()=>[{...fx.workspace},{WorkspaceID:'W2',SpreadsheetID:record.BackupFileID,PartitionPolicy:''}];
  fx.lock.tryLock();
  assert.throws(()=>fx.context.YearlyBackupSets.prune(root,record),error=>error.code==='CONFLICT');
  fx.lock.releaseLock();assert.equal(fx.files.get(record.BackupFileID).trashed,false);
});

test('backup execution budget stops before copying or publishing incomplete results',()=>{
  const fx=populated();fx.lock.tryLock();
  assert.throws(()=>fx.context.YearlyBackupSets.create(root,fx.workspace,Date.now()-1),error=>error.code==='SERVER_BUSY');
  fx.lock.releaseLock();assert.equal(fx.controls.copies,0);assert.equal(fx.backups.length,0);
});

test('incomplete or tampered activation checkpoints cannot publish a file-set backup',()=>{
  for(const failure of ['incomplete','tampered']) {
    const fx=populated();
    if(failure==='incomplete') {
      const state=fx.context.YearlyEntryStorage.activationState(fx.core,'W1','owner@example.test');
      fx.lock.tryLock();
      fx.context.YearlyEntryStorage.writeActivation(fx.core,'W1','owner@example.test',state.sheet,{...state.record,State:'PREPARING'});
      fx.lock.releaseLock();
    } else fx.core.getSheetByName('EntryStorageActivation').values[1][1]='FOREIGN-CORE';
    assert.throws(()=>fx.backup(),error=>error.code==='CONFLICT');
    assert.equal(fx.controls.copies,0);assert.equal(fx.backups.length,0);
    assert.equal(fx.workspace.SpreadsheetID,'CORE-1');
    assert.equal(fx.controls.locked,false);
  }
});
