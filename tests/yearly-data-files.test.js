'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../apps-script/Code.gs'), 'utf8');

function fixture() {
  const books = new Map();
  const events = [];
  const controls = { locked:false, owner:true, audit:true, failCreate:false, onLock:null, flushFailure:0, shared:false, lockAvailable:true };
  let nonce = 0;
  function sheet(name, rows = 1000, columns = 26) {
    const values = [];
    const obj = {
      getName: () => name, getMaxRows: () => rows, getMaxColumns: () => columns,
      getLastRow: () => values.length,
      getLastColumn: () => Math.max(0, ...values.map(row => row.length)),
      getRange(r, c, height, width) {
        return {
          getValues: () => Array.from({length:height}, (_, i) => Array.from({length:width}, (_, j) => values[r+i-1]?.[c+j-1] ?? '')),
          setValues(data) {
            assert.ok(controls.locked);
            assert.ok(r+height-1 <= rows && c+width-1 <= columns, 'allocated grid required');
            for (let i=0;i<height;i++) {
              values[r+i-1] ||= [];
              for(let j=0;j<width;j++) values[r+i-1][c+j-1] = data[i][j];
            }
            events.push('write:'+name);
          }
        };
      },
      insertRowsAfter(at, n) { assert.equal(at, rows); assert.ok(controls.locked); rows += n; events.push('allocate:'+name); },
      insertColumnsAfter(at, n) { assert.equal(at, columns); columns += n; },
      deleteRows(at, n) { rows -= n; values.splice(at-1,n); },
      deleteColumns(_at, n) { columns -= n; },
      setFrozenRows() {},
      values,
      setGrid(r,c) { rows=r; columns=c; }
    };
    return obj;
  }
  function book(id) {
    const tabs = new Map();
    tabs.set('Sheet1', sheet('Sheet1'));
    const obj = {
      getId: () => id, getSheets: () => [...tabs.values()], getSheetByName: name => tabs.get(name) || null,
      insertSheet(name) { assert.ok(controls.locked); const tab=sheet(name); tabs.set(name,tab); return tab; },
      deleteSheet(tab) { tabs.delete(tab.getName()); }, tabs
    };
    books.set(id,obj);
    return obj;
  }
  const core=book('CORE-1');
  const lock = {
    hasLock: () => controls.locked,
    tryLock() { if(!controls.lockAvailable) return false; controls.locked=true; if(controls.onLock) controls.onLock(); return true; },
    releaseLock() { controls.locked=false; }
  };
  const context=vm.createContext({console,
    DriveApp: { Access:{PRIVATE:'PRIVATE'}, getFileById: () => ({
      isTrashed: () => false, getSharingAccess: () => controls.shared ? 'DOMAIN' : 'PRIVATE',
      getEditors: () => [], getViewers: () => [],
      getOwner: () => ({getEmail: () => controls.otherOwner ? 'other@example.test' : 'owner@example.test'})
    }) },
    LockService:{getScriptLock:()=>lock},
    SpreadsheetApp:{
      openById(id) { if(!books.has(id)) throw new Error('File unavailable'); return books.get(id); },
      create() { events.push('create'); if(controls.failCreate) throw new Error('Uncertain create'); return book('DATA-'+(++nonce)); },
      flush() { events.push('flush'); if(controls.flushFailure && --controls.flushFailure===0) throw new Error('Uncertain flush'); }
    }
  });
  vm.runInContext(source,context);
  context.IdentityService.assertInstallationOwner=()=>{if(!controls.owner) throw new context.AppError('UNAUTHORIZED','Not owner',403); return 'owner@example.test';};
  context.MasterRepository.findRowByKey=()=>({WorkspaceID:'W1',SpreadsheetID:'CORE-1',Status:'ACTIVE'});
  context.MasterRepository.logGlobalAudit=record=>{events.push(record.Action); return controls.audit;};
  context.Validation.generateId=prefix=>prefix+'-'+(++nonce);
  const prepare=(year=2026, count=1)=>context.prepareYearlyDataFile_('W1',year,'TimeEntries',count);
  return {context,books,core,events,controls,prepare,sheet};
}

test('owner preparation creates actual yearly Data files and reuses the same year part', () => {
  const fx=fixture();
  const first=fx.prepare();
  assert.notEqual(first.spreadsheetId,fx.core.getId());
  assert.equal(first.year,2026);
  assert.equal(first.part,1);
  assert.equal(fx.prepare().spreadsheetId,first.spreadsheetId);
  const next=fx.prepare(2027);
  assert.notEqual(next.spreadsheetId,first.spreadsheetId);
  assert.equal(next.part,1);
  assert.equal(fx.controls.locked,false);
  assert.ok(fx.events.indexOf('DATA_FILE_CREATE_INTENT') < fx.events.indexOf('create'));
});

test('rollover includes allocated cells and pending row growth, before 70 percent', () => {
  const fx=fixture();
  const first=fx.prepare();
  const data=fx.books.get(first.spreadsheetId);
  const tab=data.getSheetByName('TimeEntries');
  // Empty cells count. Put the file one row allocation from the 70% boundary.
  const others=data.getSheets().filter(s=>s!==tab).reduce((sum,s)=>sum+s.getMaxRows()*s.getMaxColumns(),0);
  const width=fx.context.WORKSPACE_SCHEMA.TimeEntries.length;
  const rows=Math.floor((7000000-others-1)/width);
  tab.setGrid(rows,width);
  // Simulate filled allocated rows without transferring them to the allocator.
  tab.getLastRow=()=>rows;
  const next=fx.prepare();
  assert.notEqual(next.spreadsheetId,first.spreadsheetId);
  assert.equal(next.part,2);
  assert.equal(tab.getMaxRows(),rows,'old full file never grows');
});

test('missing owner approval and failed intent audit never create files', () => {
  for(const mode of ['owner','audit']) {
    const fx=fixture(); fx.controls[mode]=false;
    assert.throws(()=>fx.prepare(),error=>error.code===(mode==='owner'?'UNAUTHORIZED':'CRYPTO_FAILURE'));
    assert.equal(fx.events.includes('create'),false);
    assert.equal(fx.controls.locked,false);
  }
});

test('uncertain create leaves a durable pending checkpoint and refuses blind recreation', () => {
  const fx=fixture(); fx.controls.failCreate=true;
  assert.throws(()=>fx.prepare(),/Uncertain create/);
  fx.controls.failCreate=false;
  assert.throws(()=>fx.prepare(),error=>error.code==='CONFLICT');
  assert.equal(fx.events.filter(e=>e==='create').length,1);
});

test('historical location resolves by workspace/core/year/part, never the newest file', () => {
  const fx=fixture(); const first=fx.prepare(); fx.prepare(2027);
  assert.equal(fx.context.YearlyDataFileService.resolve(first).getId(),first.spreadsheetId);
  for(const change of [{workspaceId:'OTHER'},{coreSpreadsheetId:'OTHER'},{part:2},{year:2025},{spreadsheetId:'CORE-1'}]) {
    assert.throws(()=>fx.context.YearlyDataFileService.resolve({...first,...change}));
  }
});

test('allocation failures release the lock; initialized registered files are retained for retry', () => {
  const fx=fixture(); const first=fx.prepare();
  const tab=fx.books.get(first.spreadsheetId).getSheetByName('TimeEntries');
  tab.getLastRow=()=>tab.getMaxRows();
  const original=tab.insertRowsAfter;
  tab.insertRowsAfter=()=>{throw new Error('Allocation failed');};
  assert.throws(()=>fx.prepare(),/Allocation failed/);
  assert.equal(fx.controls.locked,false);
  tab.insertRowsAfter=original;
  assert.equal(fx.prepare().spreadsheetId,first.spreadsheetId);
});

test('Data file privacy is checked before initialization and resolution', () => {
  const fx=fixture(); fx.controls.shared=true;
  assert.throws(()=>fx.prepare(),error=>error.code==='PERMISSION_DENIED');
  const created=[...fx.books.values()].find(book=>book!==fx.core);
  assert.equal(created.getSheetByName('TimeEntries'),null);
  fx.controls.shared=false;
  const location=fx.prepare();
  assert.equal(location.spreadsheetId,created.getId());
  fx.controls.shared=true;
  assert.throws(()=>fx.context.YearlyDataFileService.resolve(location),error=>error.code==='PERMISSION_DENIED');
  fx.controls.shared=false;
  fx.controls.otherOwner=true;
  assert.throws(()=>fx.context.YearlyDataFileService.resolve(location),error=>error.code==='PERMISSION_DENIED');
});

test('bounded registry rejects duplicate locations, broken sequences and foreign cohort metadata', () => {
  for(const kind of ['duplicate','part','cohort','limit']) {
    const fx=fixture(); fx.prepare();
    const registry=fx.core.getSheetByName('DataFileRegistry');
    if(kind==='duplicate') registry.values.push([...registry.values[1]]);
    if(kind==='part') registry.values[1][3]=3;
    if(kind==='cohort') registry.values[1][1]='OTHER-CORE';
    if(kind==='limit') registry.getLastRow=()=>514;
    const before=fx.events.filter(e=>e==='create').length;
    assert.throws(()=>fx.prepare(),error=>error.code==='CONFLICT');
    assert.equal(fx.events.filter(e=>e==='create').length,before);
    assert.equal(fx.controls.locked,false);
  }
});

test('registered pending files recover after initialization flush uncertainty without duplicate creation', () => {
  const fx=fixture();
  // Interrupt immediately after DataFileInfo is written; its untrimmed grid is
  // still recognized on retry and no existing data is removed.
  const create=fx.context.SpreadsheetApp.create;
  fx.context.SpreadsheetApp.create=()=>{
    const data=create();
    const insert=data.insertSheet;
    data.insertSheet=name=>{
      const tab=insert(name);
      if(name==='DataFileInfo') {
        const trim=tab.deleteColumns;
        tab.deleteColumns=(at,count)=>{ trim(at,count); throw new Error('Initialization interrupted'); };
      }
      return tab;
    };
    return data;
  };
  assert.throws(()=>fx.prepare(),/Initialization interrupted/);
  const created=[...fx.books.values()].find(book=>book!==fx.core);
  const location=fx.prepare();
  assert.equal(location.spreadsheetId,created.getId());
  assert.equal(fx.events.filter(e=>e==='create').length,1);
});

test('pending allocations must be bounded integer rows in a declared Data table', () => {
  const fx=fixture();
  for(const count of [0,-1,251,1.5,'1',true]) assert.throws(()=>fx.prepare(2026,count),error=>error.code==='VALIDATION_ERROR');
  assert.throws(()=>fx.context.prepareYearlyDataFile_('W1',2026,'Projects',1),error=>error.code==='VALIDATION_ERROR');
  assert.equal(fx.events.includes('create'),false);
});

test('workspace state and owner are rechecked after waiting for the writer lock', () => {
  for(const kind of ['owner','workspace']) {
    const fx=fixture();
    fx.controls.onLock=()=>{
      if(kind==='owner') fx.controls.owner=false;
      else fx.context.MasterRepository.findRowByKey=()=>({WorkspaceID:'W1',SpreadsheetID:'CORE-1',Status:'MAINTENANCE'});
    };
    assert.throws(()=>fx.prepare());
    assert.equal(fx.events.includes('create'),false);
    assert.equal(fx.controls.locked,false);
  }
});

test('exact 70% boundary rotates even when the requested rows fit the existing grid', () => {
  const fx=fixture(); const first=fx.prepare();
  const book=fx.books.get(first.spreadsheetId);
  const tab=book.getSheetByName('TimeEntries');
  const extra=fx.sheet('ExtraAllocatedGrid',1,1);
  book.tabs.set('ExtraAllocatedGrid',extra);
  const allocated=fx.context.YearlyDataFileService._allocated(book);
  extra.setGrid(7000000-allocated+1,1);
  const beforeRows=tab.getMaxRows();
  const next=fx.prepare();
  assert.equal(next.part,2);
  assert.equal(tab.getMaxRows(),beforeRows);
});

test('failed completion audit returns no location and retry reuses the already registered file', () => {
  const fx=fixture();
  const audit=fx.context.MasterRepository.logGlobalAudit;
  fx.context.MasterRepository.logGlobalAudit=record=>record.Action==='DATA_FILE_READY_COMPLETED'?false:audit(record);
  assert.throws(()=>fx.prepare(),error=>error.code==='CRYPTO_FAILURE');
  assert.equal(fx.controls.locked,false);
  const fileId=[...fx.books.keys()].find(id=>id!=='CORE-1');
  fx.context.MasterRepository.logGlobalAudit=audit;
  assert.equal(fx.prepare().spreadsheetId,fileId);
  assert.equal(fx.events.filter(e=>e==='create').length,1);
});

test('failed allocation completion audit preserves applied grid and returns only after a verified retry', () => {
  const fx=fixture(); const first=fx.prepare();
  const audit=fx.context.MasterRepository.logGlobalAudit;
  fx.context.MasterRepository.logGlobalAudit=record=>record.Action==='DATA_FILE_ALLOCATION_COMPLETED'?false:audit(record);
  assert.throws(()=>fx.prepare(2026,250),error=>error.code==='CRYPTO_FAILURE');
  const sheet=fx.books.get(first.spreadsheetId).getSheetByName('TimeEntries');
  assert.ok(sheet.getMaxRows()>=251);
  assert.equal(fx.controls.locked,false);
  fx.context.MasterRepository.logGlobalAudit=audit;
  assert.equal(fx.prepare(2026,250).spreadsheetId,first.spreadsheetId);
});

test('flush uncertainty never causes blind recreation and always releases the writer lock', () => {
  for(const failure of [1,2,3,4,5,6,7,8,9,10,11,12]) {
    const fx=fixture(); fx.controls.flushFailure=failure;
    assert.throws(()=>fx.prepare(),/Uncertain flush/);
    assert.equal(fx.controls.locked,false);
    const creations=fx.events.filter(e=>e==='create').length;
    try { fx.prepare(); } catch(error) { assert.equal(error.code,'CONFLICT'); }
    assert.ok(fx.events.filter(e=>e==='create').length<=Math.max(1,creations));
  }
});

test('unavailable writer lock creates no registry or file', () => {
  const fx=fixture(); fx.controls.lockAvailable=false;
  assert.throws(()=>fx.prepare(),error=>error.code==='SERVER_BUSY');
  assert.equal(fx.core.getSheetByName('DataFileRegistry'),null);
  assert.equal(fx.events.includes('create'),false);
});
