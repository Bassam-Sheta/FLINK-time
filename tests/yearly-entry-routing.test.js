'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/yearly-entry-fixture');

test('activation preserves legacy entries and new writes automatically use yearly files',()=>{
  const fx=fixture();fx.lock.tryLock();
  const old=fx.entry('OLD');fx.core.getSheetByName('TimeEntries').appendRow(Array.from(fx.context.WORKSPACE_SCHEMA.TimeEntries,key=>old[key]??''));fx.lock.releaseLock();
  fx.activate();fx.controls.owner=false;
  fx.repo.createTimeEntry('W1',fx.entry('NEW'));
  assert.equal(fx.core.getSheetByName('TimeEntries').getLastRow(),2);
  const loaded=fx.repo.getEntry('W1','NEW');
  assert.equal(loaded.EntryID,'NEW');assert.notEqual(loaded._rowIndex.spreadsheetId,'CORE-1');
  assert.deepEqual(Array.from(fx.repo.listTimeEntries('W1'),e=>e.EntryID).sort(),['NEW','OLD']);
});

test('rotation, changed dates and replay preserve immutable entry identity and original location',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('FIRST'));
  const first=fx.repo.getEntry('W1','FIRST');
  const file=fx.books.get(first._rowIndex.spreadsheetId);
  const tab=file.getSheetByName('TimeEntries');
  tab.setGrid(Math.ceil(7000000/tab.getMaxColumns()),tab.getMaxColumns());
  fx.repo.createTimeEntry('W1',fx.entry('SECOND'));
  const second=fx.repo.getEntry('W1','SECOND');assert.notEqual(second._rowIndex.spreadsheetId,first._rowIndex.spreadsheetId);
  fx.repo.createTimeEntry('W1',fx.entry('FIRST'));
  assert.equal(fx.repo.listTimeEntries('W1').length,2);
  fx.repo.updateTimeEntry('W1','FIRST',{StartUTC:'2025-12-01T08:00:00.000Z',Version:2});
  const edited=fx.repo.getEntry('W1','FIRST');
  assert.equal(edited._rowIndex.spreadsheetId,first._rowIndex.spreadsheetId);
  assert.equal(edited.Version,2);
});

test('backdated inserts use their original year while reports see all years and soft deletes',()=>{
  const fx=fixture();fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('CURRENT'));
  fx.repo.createTimeEntry('W1',fx.entry('BACKDATED','2024-12-31T23:00:00.000Z'));
  assert.equal(fx.repo.getEntry('W1','BACKDATED')._rowIndex.year,2024);
  fx.repo.updateTimeEntry('W1','CURRENT',{Status:'DELETED'});
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
  assert.equal(fx.repo.getEntryAnyStatus('W1','CURRENT').Status,'DELETED');
});

test('an applied append followed by an error is found on retry instead of duplicated',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('SEED'));fx.controls.failWrite='TimeEntries';
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('RETRY')));
  fx.controls.failWrite=null;
  fx.repo.createTimeEntry('W1',fx.entry('RETRY'));
  assert.equal(fx.repo.listTimeEntries('W1').filter(e=>e.EntryID==='RETRY').length,1);
  assert.equal(fx.controls.locked,false);
});

test('cross-workspace and stale Core locations never authorize historical writes',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('E1'));
  const row=fx.repo.getEntry('W1','E1');
  for(const change of [{workspaceId:'OTHER'},{coreSpreadsheetId:'OTHER'},{spreadsheetId:'CORE-1'},{year:2025}]){
    assert.throws(()=>fx.repo.updateRow('W1','TimeEntries',{...row._rowIndex,...change},{Description:'bad'}));
  }
  assert.equal(fx.repo.getEntry('W1','E1').Description,'');
});

test('writer lock ownership is retained by callers and queued state changes reject writes',()=>{
  const fx=fixture();fx.activate();fx.lock.tryLock();
  fx.repo.createTimeEntry('W1',fx.entry('LOCKED'));
  assert.equal(fx.controls.locked,true);fx.lock.releaseLock();
  fx.controls.onLock=()=>{fx.workspace.Status='MAINTENANCE';};
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('DENIED')),error=>error.code==='CONFLICT');
  assert.equal(fx.controls.locked,false);
  fx.workspace.Status='ACTIVE';fx.controls.onLock=null;
  assert.equal(fx.repo.getEntry('W1','DENIED'),null);
});

test('failed activation verification leaves a durable blocking checkpoint until owner retry',()=>{
  const fx=fixture();fx.controls.failAudit='ENTRY_STORAGE_ENABLE_VERIFIED';
  assert.throws(()=>fx.activate(),error=>error.code==='CRYPTO_FAILURE');
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('BLOCKED')),error=>error.code==='CONFLICT');
  fx.controls.failAudit=null;fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('READY'));
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
});

test('failed intent audit prevents append; failed completion and flush preserve exactly one attributable entry',()=>{
  for(const failure of ['intent','completion','flush']) {
    const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('SEED'));
    if(failure==='flush') {
      const sheet=fx.books.get(fx.repo.getEntry('W1','SEED')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
      const getRange=sheet.getRange;
      sheet.getRange=(...args)=>{const range=getRange(...args);const set=range.setValues;range.setValues=data=>{set(data);fx.controls.failFlush=true;};return range;};
    } else fx.controls.failAudit=failure==='intent'?'ENTRY_STORAGE_APPEND_INTENT':'ENTRY_STORAGE_APPEND_COMPLETED';
    assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('RETRY')));
    assert.equal(fx.controls.locked,false);
    fx.controls.failFlush=false;fx.controls.failAudit=null;
    const existing=fx.repo.getEntry('W1','RETRY');
    assert.equal(!!existing,failure!=='intent');
    fx.repo.createTimeEntry('W1',fx.entry('RETRY'));
    assert.equal(fx.repo.listTimeEntries('W1').filter(row=>row.EntryID==='RETRY').length,1);
    assert.ok(fx.audits.some(row=>row.Action==='ENTRY_STORAGE_APPEND_INTENT'&&row.ActorUserID==='U1'&&row.AfterJSON.EntryID==='RETRY'));
  }
});

test('stale routing caches cannot redirect writes after a workspace policy change',()=>{
  const fx=fixture();fx.context.MasterRepository._requestCache['WS:W1']={...fx.workspace};
  fx.activate();
  const current=fx.context.MasterRepository.getWorkspace;
  fx.context.MasterRepository.getWorkspace=id=>fx.context.MasterRepository._requestCache['WS:'+id]||current(id);
  fx.context.MasterRepository._requestCache['WS:W1']={...fx.workspace,PartitionPolicy:''};
  fx.repo.createTimeEntry('W1',fx.entry('FRESH'));
  assert.equal(fx.core.getSheetByName('TimeEntries').getLastRow(),1);
});

test('keyed historical lookup transfers only matching entry rows, even with a large allocated grid',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('ONE'));
  fx.repo.createTimeEntry('W1',fx.entry('TWO','2025-01-01T08:00:00Z'));
  const sheet=fx.books.get(fx.repo.getEntry('W1','ONE')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  sheet.setGrid(200000,sheet.getMaxColumns());sheet.getLastRow=()=>200000;
  fx.controls.entryCellsRead=0;
  assert.equal(fx.repo.getEntry('W1','ONE').EntryID,'ONE');
  assert.equal(fx.controls.entryCellsRead,fx.context.WORKSPACE_SCHEMA.TimeEntries.length);
});

test('actual mutation actor overrides historical entry metadata for approval and rollback auditing',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('E1'));
  fx.repo.updateTimeEntry('W1','E1',{ApprovalStatus:'APPROVED',Locked:true},{userId:'MANAGER',role:'ADMIN'});
  const audit=fx.audits.findLast(row=>row.Action==='ENTRY_STORAGE_UPDATE_COMPLETED');
  assert.equal(audit.ActorUserID,'MANAGER');assert.equal(audit.ActorRole,'ADMIN');
  assert.equal(audit.BeforeJSON.Locked,'');assert.equal(audit.AfterJSON.Locked,true);
});

function utcReporting(fx) {
  const zone=fx.context.TimezoneService;
  zone.formatDateKey=(_ws,date)=>new Date(date).toISOString().slice(0,10);
  zone.formatMonthKey=(_ws,date)=>new Date(date).toISOString().slice(0,7);
  zone.getWeekBounds=(_ws,date)=>{const start=new Date(date);start.setUTCHours(0,0,0,0);start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);return{startLocalDate:start.toISOString().slice(0,10),endLocalDate:new Date(+start+6*86400000).toISOString().slice(0,10)};};
  fx.context.AuthorizationService.assertWorkspaceAccess=(_actor,id)=>assert.equal(id,'W1');
}

test('reports and canonical rollup rebuilds reconcile legacy and all yearly entries after historical edits',()=>{
  const fx=fixture();utcReporting(fx);
  fx.lock.tryLock();fx.repo.createTimeEntry('W1',fx.entry('LEGACY','2024-01-01T08:00:00Z'));fx.lock.releaseLock();
  fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('A'));
  fx.repo.createTimeEntry('W1',fx.entry('B','2025-01-01T08:00:00Z'));
  fx.repo.updateTimeEntry('W1','A',{DurationSeconds:1800});
  const report=fx.context.ReportService.getSummaryReport({userId:'ROOT',role:'SUPER_ADMIN'},'W1',{});
  assert.equal(report.overall.totalSeconds,9000);
  const rebuilt=fx.context.RollupService.rebuildRollups('W1');assert.equal(fx.controls.locked,false);
  assert.equal(rebuilt.entriesProcessed,3);
  for(const tab of ['DailyRollups','WeeklyRollups','MonthlyRollups'])assert.equal(fx.repo.getTableData('W1',tab).rows.reduce((sum,row)=>sum+row.TotalSeconds,0),9000);
});

test('timer crossing New Year stops into the start year and replays after later file rotation',()=>{
  const fx=fixture({now:'2027-01-01T00:30:00Z'});utcReporting(fx);fx.activate();
  fx.context.TrackingPolicyService.validateTrackingContext=()=>({projectId:'',taskId:'',description:'Synthetic',tagIdsCsv:'',billable:false});
  fx.repo.logWorkspaceAudit=()=>true;
  const user={userId:'U1',role:'USER'};
  fx.lock.tryLock();fx.repo.createActiveTimer('W1',{TimerID:'TMR-NEWYEAR',UserID:'U1',StartedAtUTC:'2026-12-31T23:30:00Z',Source:'WEB'});fx.lock.releaseLock();
  const stopped=fx.context.TimerService.stopTimer(user,'W1',{timerId:'TMR-NEWYEAR'});
  assert.equal(stopped.DurationSeconds,3600);
  const entry=fx.repo.listTimeEntries('W1')[0];assert.equal(entry._rowIndex.year,2026);assert.equal(entry.ApprovalStatus,'OPEN');assert.equal(entry.Locked,false);
  const tab=fx.books.get(entry._rowIndex.spreadsheetId).getSheetByName('TimeEntries');tab.setGrid(Math.ceil(7000000/tab.getMaxColumns()),tab.getMaxColumns());
  fx.repo.createTimeEntry('W1',fx.entry('OTHER'));
  const replay=fx.context.TimerService.stopTimer(user,'W1',{timerId:'TMR-NEWYEAR'});
  assert.equal(replay.replayed,true);assert.equal(replay.EntryID,entry.EntryID);assert.equal(fx.repo.listTimeEntries('W1').length,2);
});

test('capacity metrics include every file and use the fullest file for utilization',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('A'));fx.repo.createTimeEntry('W1',fx.entry('B','2025-01-01T08:00:00Z'));
  const metrics=fx.context.JobService.getCapacityMetrics('W1');
  const books=['CORE-1',fx.repo.getEntry('W1','A')._rowIndex.spreadsheetId,fx.repo.getEntry('W1','B')._rowIndex.spreadsheetId].map(id=>fx.books.get(id));
  const totals=books.map(book=>book.getSheets().reduce((sum,sheet)=>sum+sheet.getMaxRows()*sheet.getMaxColumns(),0));
  assert.equal(metrics.fileCount,3);assert.equal(metrics.totalCells,totals.reduce((a,b)=>a+b));
  assert.equal(metrics.utilizationPct,Number((Math.max(...totals)/100000).toFixed(2)));
});

test('duplicate EntryIDs, wrong execution owner and hard deletions fail closed',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('ONE'));
  const row=fx.repo.getEntry('W1','ONE');
  assert.throws(()=>fx.repo.deleteRow('W1','TimeEntries',row._rowIndex),error=>error.code==='CONFLICT');
  fx.controls.effectiveOwner='other@example.test';
  assert.throws(()=>fx.repo.getEntry('W1','ONE'),error=>error.code==='PERMISSION_DENIED');
  fx.controls.effectiveOwner='owner@example.test';
  const sheet=fx.books.get(row._rowIndex.spreadsheetId).getSheetByName('TimeEntries');sheet.values.push([...sheet.values[1]]);
  assert.throws(()=>fx.repo.getEntry('W1','ONE'),error=>error.code==='CONFLICT');
  assert.throws(()=>fx.repo.listTimeEntries('W1'),error=>error.code==='CONFLICT');
});

test('reusing an EntryID with a changed payload cannot silently acknowledge another mutation',()=>{
  const fx=fixture();fx.activate();const original=fx.entry('REPLAY');
  fx.repo.createTimeEntry('W1',original);
  for(const change of [{DurationSeconds:7200},{StartUTC:'2025-01-01T08:00:00Z'},{ProjectID:'OTHER'},{UserID:'OTHER'}]) {
    assert.throws(()=>fx.repo.createTimeEntry('W1',{...original,...change}),error=>error.code==='CONFLICT');
  }
  assert.equal(fx.repo.getEntry('W1','REPLAY').DurationSeconds,3600);
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
});
