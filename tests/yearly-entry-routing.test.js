'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/yearly-entry-fixture');
const worker={userId:'U1',role:'USER'};

test('activation preserves legacy entries and new writes automatically use yearly files',()=>{
  const fx=fixture();fx.lock.tryLock();
  const old=fx.entry('OLD');fx.core.getSheetByName('TimeEntries').appendRow(Array.from(fx.context.WORKSPACE_SCHEMA.TimeEntries,key=>old[key]??''));fx.lock.releaseLock();
  fx.activate();fx.controls.owner=false;
  fx.repo.createTimeEntry('W1',fx.entry('NEW'),worker);
  assert.equal(fx.core.getSheetByName('TimeEntries').getLastRow(),2);
  const loaded=fx.repo.getEntry('W1','NEW');
  assert.equal(loaded.EntryID,'NEW');assert.notEqual(loaded._rowIndex.spreadsheetId,'CORE-1');
  assert.deepEqual(Array.from(fx.repo.listTimeEntries('W1'),e=>e.EntryID).sort(),['NEW','OLD']);
});

test('rotation, changed dates and replay preserve immutable entry identity and original location',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('FIRST'),worker);
  const first=fx.repo.getEntry('W1','FIRST');
  const file=fx.books.get(first._rowIndex.spreadsheetId);
  const tab=file.getSheetByName('TimeEntries');
  tab.setGrid(Math.ceil(7000000/tab.getMaxColumns()),tab.getMaxColumns());
  fx.repo.createTimeEntry('W1',fx.entry('SECOND'),worker);
  const second=fx.repo.getEntry('W1','SECOND');assert.notEqual(second._rowIndex.spreadsheetId,first._rowIndex.spreadsheetId);
  fx.repo.createTimeEntry('W1',fx.entry('FIRST'),worker);
  assert.equal(fx.repo.listTimeEntries('W1').length,2);
  fx.repo.updateTimeEntry('W1','FIRST',{StartUTC:'2025-12-01T08:00:00.000Z',Version:2},worker);
  const edited=fx.repo.getEntry('W1','FIRST');
  assert.equal(edited._rowIndex.spreadsheetId,first._rowIndex.spreadsheetId);
  assert.equal(edited.Version,2);
});

test('backdated inserts use their original year while reports see all years and soft deletes',()=>{
  const fx=fixture();fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('CURRENT'),worker);
  fx.repo.createTimeEntry('W1',fx.entry('BACKDATED','2024-12-31T23:00:00.000Z'),worker);
  assert.equal(fx.repo.getEntry('W1','BACKDATED')._rowIndex.year,2024);
  fx.repo.updateTimeEntry('W1','CURRENT',{Status:'DELETED'},worker);
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
  assert.equal(fx.repo.getEntryAnyStatus('W1','CURRENT').Status,'DELETED');
});

test('an applied append followed by an error is found on retry instead of duplicated',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('SEED'),worker);fx.controls.failWrite='TimeEntries';
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('RETRY'),worker));
  fx.controls.failWrite=null;
  fx.repo.createTimeEntry('W1',fx.entry('RETRY'),worker);
  assert.equal(fx.repo.listTimeEntries('W1').filter(e=>e.EntryID==='RETRY').length,1);
  assert.equal(fx.controls.locked,false);
});

test('cross-workspace and stale Core locations never authorize historical writes',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('E1'),worker);
  const row=fx.repo.getEntry('W1','E1');
  for(const change of [{workspaceId:'OTHER'},{coreSpreadsheetId:'OTHER'},{spreadsheetId:'CORE-1'},{year:2025}]){
    assert.throws(()=>fx.repo.updateRow('W1','TimeEntries',{...row._rowIndex,...change},{Description:'bad'},worker),error=>error.code==='CONFLICT');
  }
  assert.equal(fx.repo.getEntry('W1','E1').Description,'');
});

test('writer lock ownership is retained by callers and queued state changes reject writes',()=>{
  const fx=fixture();fx.activate();fx.lock.tryLock();
  fx.repo.createTimeEntry('W1',fx.entry('LOCKED'),worker);
  assert.equal(fx.controls.locked,true);fx.lock.releaseLock();
  fx.controls.onLock=()=>{fx.workspace.Status='MAINTENANCE';};
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('DENIED'),worker),error=>error.code==='CONFLICT');
  assert.equal(fx.controls.locked,false);
  fx.workspace.Status='ACTIVE';fx.controls.onLock=null;
  assert.equal(fx.repo.getEntry('W1','DENIED'),null);
});

test('failed activation verification leaves a durable blocking checkpoint until owner retry',()=>{
  const fx=fixture();fx.controls.failAudit='ENTRY_STORAGE_ENABLE_VERIFIED';
  assert.throws(()=>fx.activate(),error=>error.code==='CRYPTO_FAILURE');
  assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('BLOCKED'),worker),error=>error.code==='CONFLICT');
  fx.controls.failAudit=null;fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('READY'),worker);
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
});

test('failed intent audit prevents append; failed completion and flush preserve exactly one attributable entry',()=>{
  for(const failure of ['intent','completion','flush']) {
    const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('SEED'),worker);
    if(failure==='flush') {
      const sheet=fx.books.get(fx.repo.getEntry('W1','SEED')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
      const getRange=sheet.getRange;
      sheet.getRange=(...args)=>{const range=getRange(...args);const set=range.setValues;range.setValues=data=>{set(data);fx.controls.failFlush=true;};return range;};
    } else fx.controls.failAudit=failure==='intent'?'ENTRY_STORAGE_APPEND_INTENT':'ENTRY_STORAGE_APPEND_COMPLETED';
    assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('RETRY'),worker));
    assert.equal(fx.controls.locked,false);
    fx.controls.failFlush=false;fx.controls.failAudit=null;
    const existing=fx.repo.getEntry('W1','RETRY');
    assert.equal(!!existing,failure!=='intent');
    fx.repo.createTimeEntry('W1',fx.entry('RETRY'),worker);
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
  fx.repo.createTimeEntry('W1',fx.entry('FRESH'),worker);
  assert.equal(fx.core.getSheetByName('TimeEntries').getLastRow(),1);
});

test('keyed historical lookup transfers only matching entry rows, even with a large allocated grid',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('ONE'),worker);
  fx.repo.createTimeEntry('W1',fx.entry('TWO','2025-01-01T08:00:00Z'),worker);
  const sheet=fx.books.get(fx.repo.getEntry('W1','ONE')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  sheet.setGrid(200000,sheet.getMaxColumns());sheet.getLastRow=()=>200000;
  fx.controls.entryCellsRead=0;
  assert.equal(fx.repo.getEntry('W1','ONE').EntryID,'ONE');
  assert.equal(fx.controls.entryCellsRead,fx.context.WORKSPACE_SCHEMA.TimeEntries.length);
});

test('actual mutation actor overrides historical entry metadata for approval and rollback auditing',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('E1'),worker);
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
  fx.lock.tryLock();fx.repo.createTimeEntry('W1',fx.entry('LEGACY','2024-01-01T08:00:00Z'),worker);fx.lock.releaseLock();
  fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('A'),worker);
  fx.repo.createTimeEntry('W1',fx.entry('B','2025-01-01T08:00:00Z'),worker);
  fx.repo.updateTimeEntry('W1','A',{DurationSeconds:1800},worker);
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
  fx.repo.createTimeEntry('W1',fx.entry('OTHER'),worker);
  const replay=fx.context.TimerService.stopTimer(user,'W1',{timerId:'TMR-NEWYEAR'});
  assert.equal(replay.replayed,true);assert.equal(replay.EntryID,entry.EntryID);assert.equal(fx.repo.listTimeEntries('W1').length,2);
});

test('capacity metrics include every file and use the fullest file for utilization',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('A'),worker);fx.repo.createTimeEntry('W1',fx.entry('B','2025-01-01T08:00:00Z'),worker);
  const metrics=fx.context.JobService.getCapacityMetrics('W1');
  const books=['CORE-1',fx.repo.getEntry('W1','A')._rowIndex.spreadsheetId,fx.repo.getEntry('W1','B')._rowIndex.spreadsheetId].map(id=>fx.books.get(id));
  const totals=books.map(book=>book.getSheets().reduce((sum,sheet)=>sum+sheet.getMaxRows()*sheet.getMaxColumns(),0));
  assert.equal(metrics.fileCount,3);assert.equal(metrics.totalCells,totals.reduce((a,b)=>a+b));
  assert.equal(metrics.utilizationPct,Number((Math.max(...totals)/100000).toFixed(2)));
});

test('duplicate EntryIDs, wrong execution owner and hard deletions fail closed',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('ONE'),worker);
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
  fx.repo.createTimeEntry('W1',original,worker);
  for(const change of [{DurationSeconds:7200},{StartUTC:'2025-01-01T08:00:00Z'},{ProjectID:'OTHER'},{UserID:'OTHER'}]) {
    assert.throws(()=>fx.repo.createTimeEntry('W1',{...original,...change},worker),error=>error.code==='CONFLICT');
  }
  assert.equal(fx.repo.getEntry('W1','REPLAY').DurationSeconds,3600);
  assert.equal(fx.repo.listTimeEntries('W1').length,1);
});

test('queued edits reject changed row snapshots, including approval changes without a version bump',()=>{
  for(const legacy of [false,true]) for(const field of ['Version','Locked','Description']) {
    const fx=fixture();
    if(legacy) {
      fx.lock.tryLock();fx.repo.createTimeEntry('W1',fx.entry('RACE'),worker);fx.lock.releaseLock();
    }
    fx.activate();
    if(!legacy)fx.repo.createTimeEntry('W1',fx.entry('RACE'),worker);
    const entry=fx.repo.getEntry('W1','RACE');
    const sheet=fx.books.get(entry._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
    const priorAudits=fx.audits.length;
    fx.controls.onLock=()=>{
      sheet.values[entry._rowIndex.rowIndex-1][fx.context.WORKSPACE_SCHEMA.TimeEntries.indexOf(field)]=field==='Version'?2:field==='Locked'?true:'queued winner';
    };
    assert.throws(()=>fx.repo.updateTimeEntry('W1','RACE',{Description:'stale overwrite',Version:2},worker),error=>error.code==='CONFLICT');
    assert.equal(fx.controls.locked,false);
    assert.equal(fx.audits.length,priorAudits,'stale edits produce no mutation intent/completion');
    assert.notEqual(fx.repo.getEntry('W1','RACE').Description,'stale overwrite');
  }
});

test('immutable IDs survive row movement and return the actual sanitized row and current locator',()=>{
  const fx=fixture();fx.activate();
  fx.repo.createTimeEntry('W1',fx.entry('FIRST'),worker);fx.repo.createTimeEntry('W1',fx.entry('SECOND'),worker);
  const second=fx.repo.getEntry('W1','SECOND');
  const sheet=fx.books.get(second._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  fx.controls.onLock=()=>{sheet.values.splice(1,1);};
  const updated=fx.repo.updateTimeEntry('W1','SECOND',{Description:'=SUM(A1)'},worker);
  assert.equal(updated._rowIndex.rowIndex,2);
  assert.equal(updated.Description,"'=SUM(A1)");
  assert.equal(updated._rowIndex.rowHash,fx.repo.getEntry('W1','SECOND')._rowIndex.rowHash);
});

test('entry writes require an explicit actor and do not infer one from historical row metadata',()=>{
  const fx=fixture();fx.activate();fx.repo.createTimeEntry('W1',fx.entry('EXISTING'),worker);
  const audits=fx.audits.length;
  for(const actor of [undefined,{}, {userId:'MANAGER'}, {userId:7,role:'ADMIN'}, {userId:'MANAGER',role:7}, {userId:'MANAGER',role:'ENTRY_STORAGE'}]) {
    assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('NO-ACTOR'),actor),error=>error.code==='CONFLICT');
    assert.throws(()=>fx.repo.updateTimeEntry('W1','EXISTING',{Description:'incorrect actor'},actor),error=>error.code==='CONFLICT');
  }
  assert.equal(fx.repo.getEntry('W1','NO-ACTOR'),null);
  assert.equal(fx.repo.getEntry('W1','EXISTING').Description,'');
  assert.equal(fx.audits.length,audits);
});

test('interrupted activation is blocked even after the active policy applies, and owner retry completes the original audit pair',()=>{
  for(const failure of ['ENTRY_STORAGE_ENABLE_VERIFIED','ENTRY_STORAGE_ENABLE_COMPLETED','policy-write','policy-flush']) {
    const fx=fixture();
    const update=fx.context.MasterRepository.updateWorkspace;
    if(failure==='policy-write'||failure==='policy-flush')fx.context.MasterRepository.updateWorkspace=(id,updates)=>{
      update(id,updates);
      if(updates.PartitionPolicy==='YEARLY_ENTRIES_V1') {
        if(failure==='policy-write')throw new Error('Applied active-policy write failed');
        fx.controls.failFlush=true;
      }
    };
    else fx.controls.failAudit=failure;
    assert.throws(()=>fx.activate());
    // The next request observes durable state after the one uncertain flush.
    fx.controls.failFlush=false;
    const original=fx.audits.find(row=>row.Action==='ENTRY_STORAGE_ENABLE_INTENT');
    assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('BLOCKED'),worker),error=>error.code==='CONFLICT');
    assert.throws(()=>fx.repo.listTimeEntries('W1'),error=>error.code==='CONFLICT');
    fx.controls.owner=false;
    assert.throws(()=>fx.activate(),error=>error.code==='UNAUTHORIZED');
    fx.controls.owner=true;fx.controls.failAudit=null;fx.controls.failFlush=false;fx.context.MasterRepository.updateWorkspace=update;
    fx.activate();
    const completed=fx.audits.findLast(row=>row.Action==='ENTRY_STORAGE_ENABLE_COMPLETED');
    assert.ok(completed,'activation must have a completion audit after the policy write');
    assert.equal(completed.CorrelationID,original.CorrelationID);
    assert.equal(completed.ActorUserID,'owner@example.test');
    assert.equal(completed.BeforeJSON.policy,'','recovery retains the original before state, not PREPARING');
    fx.repo.createTimeEntry('W1',fx.entry('READY'),worker);
    assert.equal(fx.repo.listTimeEntries('W1').length,1);
    assert.equal(fx.controls.locked,false);
  }
});

test('completed activation is idempotent and missing or tampered activation evidence cannot enable routing',()=>{
  for(const tamper of ['missing','operation','owner','core','extra-row']) {
    const fx=fixture();fx.activate();const count=fx.audits.length;fx.activate();
    assert.equal(fx.audits.length,count,'no second activation transition');
    const sheet=fx.core.getSheetByName('EntryStorageActivation');
    assert.ok(sheet,'activation has a durable checkpoint');
    if(tamper==='missing')fx.core.tabs.delete('EntryStorageActivation');
    else if(tamper==='extra-row')sheet.values.push([...sheet.values[1]]);
    else sheet.values[1][{operation:2,owner:3,core:1}[tamper]]='FORGED';
    assert.throws(()=>fx.repo.createTimeEntry('W1',fx.entry('BLOCKED'),worker),error=>error.code==='CONFLICT');
    assert.throws(()=>fx.activate(),error=>error.code==='CONFLICT');
    assert.equal(fx.core.getSheetByName('TimeEntries').getLastRow(),1);
  }
});

test('activation checkpoint uncertainty preserves legacy data and retries the same operation without recreating storage',()=>{
  for(const stage of ['PREPARING','COMPLETE']) {
    const fx=fixture();fx.lock.tryLock();fx.repo.createTimeEntry('W1',fx.entry('LEGACY'),worker);fx.lock.releaseLock();
    const insert=fx.core.insertSheet;
    fx.core.insertSheet=name=>{
      const sheet=insert(name);
      if(name==='EntryStorageActivation') {
        const getRange=sheet.getRange;
        sheet.getRange=(...args)=>{
          const range=getRange(...args),set=range.setValues;
          range.setValues=data=>{set(data);if(data[0][6]===stage&&!fx.controls.checkpointFailure){fx.controls.checkpointFailure=true;throw new Error('Applied checkpoint write failed');}};
          return range;
        };
      }
      return sheet;
    };
    assert.throws(()=>fx.activate());
    const original=fx.audits.find(row=>row.Action==='ENTRY_STORAGE_ENABLE_INTENT');
    assert.equal(fx.controls.locked,false);
    fx.activate();
    const completed=fx.audits.findLast(row=>row.Action==='ENTRY_STORAGE_ENABLE_COMPLETED');
    assert.equal(completed.CorrelationID,original.CorrelationID);
    assert.equal(completed.BeforeJSON.policy,'');
    assert.equal(fx.repo.getEntry('W1','LEGACY')._rowIndex.spreadsheetId,'CORE-1');
    assert.equal(fx.books.size,2,'activation itself creates no new Data file');
  }
});

test('yearly entry batches propagate the actual actor and reject actorless batches before any entry writes',()=>{
  const fx=fixture();fx.activate();
  const manager={userId:'MANAGER',role:'ADMIN'};
  assert.throws(()=>fx.repo.appendRows('W1','TimeEntries',[fx.entry('NO-ACTOR')]),error=>error.code==='CONFLICT');
  const rows=fx.repo.appendRows('W1','TimeEntries',[fx.entry('A'),fx.entry('B')],manager);
  assert.equal(rows.length,2);
  const completions=fx.audits.filter(row=>row.Action==='ENTRY_STORAGE_APPEND_COMPLETED');
  assert.equal(completions.length,2);
  assert.ok(completions.every(row=>row.ActorUserID==='MANAGER'&&row.ActorRole==='ADMIN'));
  assert.equal(fx.repo.getEntry('W1','NO-ACTOR'),null);
});
