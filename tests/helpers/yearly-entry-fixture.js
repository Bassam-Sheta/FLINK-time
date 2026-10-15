'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(path.resolve(__dirname,'../../apps-script/Code.gs'),'utf8');

function fixture(options={}) {
  const books=new Map(), files=new Map(), audits=[], backups=[];
  const controls={locked:false, owner:true, audit:true, failFlush:false, failWrite:null, user:'worker@example.test', copies:0, entryCellsRead:0};
  let nonce=0;
  function sheet(name, rows=1000, columns=26) {
    const values=[];
    const tab={values,getName:()=>name,getMaxRows:()=>rows,getMaxColumns:()=>columns,
      getLastRow:()=>values.length,getLastColumn:()=>Math.max(0,...values.map(row=>row.length)),
      setGrid(r,c){rows=r;columns=c;},
      getRange(r,c,n,w){
        const range={getValues:()=>{if(name==='TimeEntries'&&r>1)controls.entryCellsRead+=n*w;return Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>values[r+i-1]?.[c+j-1]??''));},
          setValues(data){assertLocked();if(r+n-1>rows||c+w-1>columns)throw new Error('Unallocated grid');
            for(let i=0;i<n;i++){values[r+i-1]||=[];for(let j=0;j<w;j++)values[r+i-1][c+j-1]=data[i][j];}
            if(controls.failWrite===name)throw new Error('Uncertain '+name+' write');
          },
          createTextFinder(value){let next=0,sensitive=true;const matches=()=>values.map((row,i)=>({row:i+1,value:row[c-1]})).filter(x=>x.row>=r&&x.row<r+n&&(sensitive?String(x.value)===String(value):String(x.value).toLowerCase()===String(value).toLowerCase()));
            const finder={matchEntireCell:()=>finder,matchCase:v=>{sensitive=v;return finder;},useRegularExpression:()=>finder,
              findNext:()=>{const a=matches();if(!a.length)return null;const item=a[next++%a.length];return{getRow:()=>item.row};},findAll:()=>matches().map(x=>({getRow:()=>x.row}))};return finder;
          }};return range;
      },
      getDataRange(){return tab.getRange(1,1,Math.max(1,values.length),Math.max(1,tab.getLastColumn()));},
      appendRow(row){assertLocked();rows=Math.max(rows,values.length+1);values.push([...row]);},
      insertRowsAfter(at,n){assertLocked();if(at!==rows)throw new Error('Unexpected insert');rows+=n;},
      insertColumnsAfter(at,n){if(at!==columns)throw new Error('Unexpected column insert');columns+=n;},
      deleteRows(at,n){assertLocked();values.splice(at-1,n);rows-=n;},deleteRow(at){tab.deleteRows(at,1);},
      deleteColumns(_at,n){columns-=n;},setFrozenRows(){}};
    return tab;
  }
  function assertLocked(){if(!controls.locked)throw new Error('Write outside lock');}
  function book(id){const tabs=new Map([['Sheet1',sheet('Sheet1')]]);
    const result={getId:()=>id,getSheets:()=>[...tabs.values()],getSheetByName:name=>tabs.get(name)||null,
      insertSheet(name){assertLocked();const s=sheet(name);tabs.set(name,s);return s;},deleteSheet(s){tabs.delete(s.getName());},tabs};
    books.set(id,result);files.set(id,{trashed:false});return result;
  }
  const core=book('CORE-1');
  const workspace={WorkspaceID:'W1',SpreadsheetID:'CORE-1',Status:'ACTIVE',Timezone:'UTC',PartitionPolicy:''};
  const lock={hasLock:()=>controls.locked,tryLock(){if(controls.lockUnavailable)return false;controls.locked=true;if(controls.onLock)controls.onLock();return true;},waitLock(){controls.locked=true;},releaseLock(){controls.locked=false;}};
  const context=vm.createContext({console,
    ...(options.now?{Date:class extends Date{constructor(...args){super(...(args.length?args:[options.now]));}static now(){return Date.parse(options.now);}}}:{}),
    Session:{getActiveUser:()=>({getEmail:()=>controls.user}),getEffectiveUser:()=>({getEmail:()=>controls.effectiveOwner||'owner@example.test'})},
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==='FLINK_INSTALL_OWNER_EMAIL'?'owner@example.test':null})},
    LockService:{getScriptLock:()=>lock},
    SpreadsheetApp:{openById(id){if(!books.has(id))throw new Error('File unavailable');return books.get(id);},create(){assertLocked();return book('FILE-'+(++nonce));},flush(){if(controls.failFlush)throw new Error('Uncertain flush');}},
    DriveApp:{Access:{PRIVATE:'PRIVATE'},getFileById(id){if(!files.has(id))throw new Error('File missing');return{
      getId:()=>id,isTrashed:()=>files.get(id).trashed,setTrashed(value){files.get(id).trashed=value;},
      getSharingAccess:()=> 'PRIVATE',getEditors:()=>[],getViewers:()=>[],getOwner:()=>({getEmail:()=> 'owner@example.test'}),
      makeCopy(){assertLocked();controls.copies++;if(controls.failCopy===controls.copies)throw new Error('Uncertain copy');const copy=book('COPY-'+(++nonce));copy.tabs.clear();for(const original of books.get(id).getSheets()){
        const t=sheet(original.getName(),original.getMaxRows(),original.getMaxColumns());for(const row of original.values)t.values.push([...row]);copy.tabs.set(t.getName(),t);
      }if(controls.onCopy)controls.onCopy(copy);return context.DriveApp.getFileById(copy.getId());}
    };}}
  });
  vm.runInContext(source,context);
  context.IdentityService.assertInstallationOwner=()=>{if(!controls.owner)throw new context.AppError('UNAUTHORIZED','Not owner',403);return 'owner@example.test';};
  context.MasterRepository.findRowByKey=(_tab,_key,value)=>value==='W1'?{...workspace}:null;
  context.MasterRepository.getWorkspace=id=>id==='W1'?{...workspace}:null;
  context.MasterRepository.updateWorkspace=(_id,updates)=>Object.assign(workspace,updates);
  context.MasterRepository.logGlobalAudit=record=>{audits.push(record);return controls.audit&&controls.failAudit!==record.Action;};
  context.MasterRepository.getTableData=tab=>({rows:tab==='BackupRegistry'?backups:tab==='Workspaces'?[{...workspace}]:[]});
  context.MasterRepository.appendRow=(tab,row)=>{assertLocked();if(tab!=='BackupRegistry')throw new Error('Unexpected master append');backups.push({...row,_rowIndex:backups.length+2});};
  context.MasterRepository.updateRow=(tab,index,updates)=>{assertLocked();if(tab!=='BackupRegistry')throw new Error('Unexpected master update');Object.assign(backups[index-2],updates);};
  context.MasterRepository.getCredentials=()=>({PasswordHash:'SYNTHETIC'});
  context.MasterRepository.getWorkspaceAccessForWorkspace=()=>[{UserID:'U1'}];
  context.SessionService.revokeAllUserSessions=()=>{if(controls.failRevoke)throw new Error('Revoke failed');};
  context.Validation.generateId=prefix=>prefix+'-'+(++nonce);
  context.SecurityService.hashToken=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
  context.SecurityService.getPepper=()=> 'SYNTHETIC-PEPPER';
  context.SecurityService.verifyPassword=()=>true;
  context.SecurityService.hmacSha256=(key,value)=>Array.from(crypto.createHmac('sha256',key).update(String(value)).digest());
  context.AuthorizationService.assertRole=()=>{};
  controls.locked=true;
  const master=book('MASTER');
  const workspaces=master.insertSheet('Workspaces');
  workspaces.getRange(1,1,1,context.MASTER_SCHEMA.Workspaces.length).setValues([Array.from(context.MASTER_SCHEMA.Workspaces)]);
  context.MasterRepository.getMasterSpreadsheet=()=>master;
  for(const [name,headers]of Object.entries(context.WORKSPACE_SCHEMA)){const s=core.insertSheet(name);s.getRange(1,1,1,headers.length).setValues([Array.from(headers)]);}
  core.getSheetByName('WorkspaceInfo').appendRow(['W1','W1','Synthetic','ACTIVE','UTC',context.CONSTANTS.SCHEMA_VERSION,new Date().toISOString()]);
  controls.locked=false;
  function entry(id,start='2026-01-01T08:00:00.000Z'){return{EntryID:id,UserID:'U1',StartUTC:start,EndUTC:new Date(Date.parse(start)+3600000).toISOString(),DurationSeconds:3600,Status:'ACTIVE',Version:1,CreatedBy:'U1',UpdatedBy:'U1'};}
  function activate(){return context.enableYearlyEntryStorage_('W1');}
  const repo=context.SheetRepository;
  return{context,workspace,core,books,files,controls,audits,entry,activate,repo,lock,book,sheet,backups};
}
module.exports={fixture};
