'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Business.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sundayBounds(value) {
  const d = new Date(value);
  const key = d.toISOString().substring(0,10);
  const base = new Date(key + 'T00:00:00.000Z');
  const delta = base.getUTCDay();
  const start = new Date(base.getTime() - delta * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return {
    startLocalDate:start.toISOString().substring(0,10),
    endLocalDate:end.toISOString().substring(0,10)
  };
}

function fixture(initialEntries = []) {
  const rawEntries = initialEntries.map(e => ({ ...e }));
  const tables = {
    DailyRollups:[],
    WeeklyRollups:[],
    MonthlyRollups:[],
    ProjectRollups:[]
  };
  let clearCalls = 0;

  global.AppError = AppError;
  global.ERROR_CODES = { NOT_FOUND:'NOT_FOUND' };
  global.CONSTANTS = {
    WORKSPACE_TABS:{
      DAILY_ROLLUPS:'DailyRollups',
      WEEKLY_ROLLUPS:'WeeklyRollups',
      MONTHLY_ROLLUPS:'MonthlyRollups',
      PROJECT_ROLLUPS:'ProjectRollups'
    }
  };
  global.TimezoneService = {
    formatDateKey(_ws,value) {
      return new Date(value).toISOString().substring(0,10);
    },
    formatMonthKey(_ws,value) {
      return new Date(value).toISOString().substring(0,7);
    },
    getWeekBounds(_ws,value) {
      return sundayBounds(value);
    }
  };
  global.SheetRepository = {
    getProject(_ws,id) {
      return {
        ProjectID:id,
        EstimateHours:id === 'P1' ? 10 : 5
      };
    },
    listTimeEntries(_ws,filters = {}) {
      return rawEntries.filter(e =>
        e.Status !== 'DELETED' &&
        (!filters.projectId || e.ProjectID === filters.projectId)
      ).map(e => ({ ...e }));
    },
    getTableData(_ws,tab) {
      return {
        rows:tables[tab].map((row,i) => ({ ...row, _rowIndex:i+2 }))
      };
    },
    appendRow(_ws,tab,row) {
      tables[tab].push({ ...row });
      return row;
    },
    updateRow(_ws,tab,rowIndex,updates) {
      Object.assign(tables[tab][rowIndex-2], updates);
    },
    clearTableCache() { clearCalls += 1; }
  };
  global.WorkspaceRouter = {
    resolveSpreadsheet() {
      return {
        getSheetByName(tab) {
          return {
            getLastRow() { return tables[tab].length + 1; },
            deleteRows() { tables[tab].splice(0, tables[tab].length); }
          };
        }
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).RollupService,
    rawEntries,
    tables,
    getClearCalls:() => clearCalls
  };
}

function entry(id, overrides = {}) {
  return {
    EntryID:id,
    UserID:'U1',
    ProjectID:'P1',
    StartUTC:'2026-09-27T08:00:00.000Z',
    EndUTC:'2026-09-27T09:00:00.000Z',
    DurationSeconds:3600,
    Billable:true,
    HourlyRateSnapshot:123.45,
    CostRateSnapshot:37.25,
    Status:'ACTIVE',
    ...overrides
  };
}

function normalizeRows(rows) {
  return rows.map(row => {
    const copy = { ...row };
    delete copy._rowIndex;
    delete copy.LastCalculatedAt;
    return copy;
  }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('canonical rollups exactly aggregate raw entries, money, and contributors', () => {
  const entries = [
    entry('E1'),
    entry('E2', {
      UserID:'U2',
      DurationSeconds:1801,
      Billable:false,
      StartUTC:'2026-09-28T10:00:00.000Z',
      EndUTC:'2026-09-28T10:30:01.000Z'
    }),
    entry('E3', {
      ProjectID:'P2',
      DurationSeconds:900,
      HourlyRateSnapshot:80,
      CostRateSnapshot:20,
      StartUTC:'2026-10-03T12:00:00.000Z',
      EndUTC:'2026-10-03T12:15:00.000Z'
    }),
    entry('DELETED', { Status:'DELETED', DurationSeconds:9999 })
  ];
  const fx = fixture(entries);
  const canonical = fx.service._buildCanonicalRollups(
    'W1', entries, 'NOW'
  );

  const p1 = canonical.ProjectRollups.find(r => r.ProjectID === 'P1');
  assert.equal(p1.TotalSeconds, 5401);
  assert.equal(p1.BillableSeconds, 3600);
  assert.equal(p1.ContributorCount, 2);
  assert.equal(p1.TotalRevenue, 123.45);
  assert.equal(
    p1.TotalCost,
    +(
      (
        Math.round((3600 * 37.25 * 100) / 3600) +
        Math.round((1801 * 37.25 * 100) / 3600)
      ) / 100
    ).toFixed(2)
  );

  assert.equal(canonical.WeeklyRollups.length, 3);
  assert.ok(canonical.WeeklyRollups.every(r => r.WeekStart === '2026-09-27'));
});

test('safe incremental CREATE sequence equals canonical full rebuild output', () => {
  const fx = fixture();
  const entries = [
    entry('E1'),
    entry('E2', {
      UserID:'U2',
      DurationSeconds:1801,
      StartUTC:'2026-09-28T10:00:00.000Z',
      EndUTC:'2026-09-28T10:30:01.000Z'
    }),
    entry('E3', {
      ProjectID:'P2',
      Billable:false,
      DurationSeconds:733,
      HourlyRateSnapshot:77.77,
      CostRateSnapshot:33.33,
      StartUTC:'2026-10-02T10:00:00.000Z',
      EndUTC:'2026-10-02T10:12:13.000Z'
    })
  ];

  for (const e of entries) {
    fx.rawEntries.push({ ...e });
    fx.service.recordTimeEntry('W1', e);
  }

  const canonical = fx.service._buildCanonicalRollups(
    'W1', fx.rawEntries, 'IGNORED'
  );

  assert.deepEqual(
    normalizeRows(fx.tables.DailyRollups),
    normalizeRows(canonical.DailyRollups)
  );
  assert.deepEqual(
    normalizeRows(fx.tables.WeeklyRollups),
    normalizeRows(canonical.WeeklyRollups)
  );
  assert.deepEqual(
    normalizeRows(fx.tables.MonthlyRollups),
    normalizeRows(canonical.MonthlyRollups)
  );
  assert.deepEqual(
    normalizeRows(fx.tables.ProjectRollups),
    normalizeRows(canonical.ProjectRollups)
  );
});

test('full rebuild replaces stale rows and invalidates all rollup table caches', () => {
  const fx = fixture([entry('E1')]);
  fx.tables.DailyRollups.push({
    RollupDate:'1999-01-01', UserID:'BAD', ProjectID:'BAD', TotalSeconds:99
  });
  fx.tables.WeeklyRollups.push({ WeekStart:'1999-01-01', UserID:'BAD', ProjectID:'BAD' });
  fx.tables.MonthlyRollups.push({ MonthKey:'1999-01', UserID:'BAD', ProjectID:'BAD' });
  fx.tables.ProjectRollups.push({ ProjectID:'BAD', TotalSeconds:99 });

  const result = fx.service.rebuildRollups('W1');
  assert.equal(result.mode, 'full-rebuild');
  assert.equal(fx.getClearCalls(), 4);
  assert.equal(fx.tables.DailyRollups.some(r => r.UserID === 'BAD'), false);
  assert.equal(fx.tables.ProjectRollups.some(r => r.ProjectID === 'BAD'), false);
});

test('metadata-only mutation skips rebuild but rollup-relevant mutation rebuilds', () => {
  const fx = fixture([entry('E1')]);
  let rebuilds = 0;
  fx.service.rebuildRollups = () => {
    rebuilds += 1;
    return { ok:true, mode:'full-rebuild' };
  };

  const before = entry('E1', { Description:'old' });
  const metadataOnly = { ...before, Description:'new' };
  const moved = { ...before, ProjectID:'P2' };

  const skipped = fx.service.reconcileMutation(
    'W1', before, metadataOnly, 'UPDATE'
  );
  assert.equal(skipped.mode, 'metadata-only');
  assert.equal(rebuilds, 0);

  fx.service.reconcileMutation('W1', before, moved, 'UPDATE');
  assert.equal(rebuilds, 1);
});

test('edit/delete/project and billable changes rebuild to exact raw-source result', () => {
  const fx = fixture([
    entry('E1'),
    entry('E2', {
      UserID:'U2',
      DurationSeconds:1800,
      StartUTC:'2026-09-28T08:00:00.000Z',
      EndUTC:'2026-09-28T08:30:00.000Z'
    })
  ]);

  fx.service.rebuildRollups('W1');

  Object.assign(fx.rawEntries[0], {
    ProjectID:'P2',
    Billable:false,
    DurationSeconds:2700,
    EndUTC:'2026-09-27T08:45:00.000Z',
    HourlyRateSnapshot:80,
    CostRateSnapshot:20
  });
  fx.rawEntries[1].Status = 'DELETED';

  fx.service.rebuildRollups('W1');
  const canonical = fx.service._buildCanonicalRollups(
    'W1', fx.rawEntries, 'IGNORED'
  );

  assert.deepEqual(
    normalizeRows(fx.tables.DailyRollups),
    normalizeRows(canonical.DailyRollups)
  );
  assert.deepEqual(
    normalizeRows(fx.tables.ProjectRollups),
    normalizeRows(canonical.ProjectRollups)
  );
});
