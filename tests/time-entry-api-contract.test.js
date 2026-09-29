'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/Code.gs'),
  'utf8'
);

test('entry update/delete API forwards expectedVersion into service layer', () => {
  assert.match(
    app,
    /TimeEntryService\.updateEntry\([\s\S]{0,250}payload\.expectedVersion/
  );
  assert.match(
    app,
    /TimeEntryService\.deleteEntry\([\s\S]{0,180}payload\.expectedVersion/
  );
});
