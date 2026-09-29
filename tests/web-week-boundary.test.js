'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/App.html'),
  'utf8'
);

test('weekly timesheet asks server to resolve workspace week from an absolute instant', () => {
  assert.match(
    html,
    /currentInstant\s*=\s*new Date\(\)\.toISOString\(\)/
  );
  assert.match(
    html,
    /timesheet\.getWeekly'[\s\S]{0,150}weekStartDate:\s*currentInstant/
  );
  assert.doesNotMatch(
    html,
    /todayStr\s*=\s*new Date\(\)\.toISOString\(\)\.substring\(0,\s*10\)/
  );
});
