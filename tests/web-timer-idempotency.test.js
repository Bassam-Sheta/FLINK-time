'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/App.html'),
  'utf8'
);

test('web timer sends operationId on start and timerId on stop', () => {
  assert.match(html, /apiCall\('timer\.start',[\s\S]{0,500}operationId/);
  assert.match(html, /apiCall\('timer\.stop',[\s\S]{0,300}timerId:\s*state\.activeTimer\.timerId/);
  assert.match(html, /pendingTimerStartOperationId/);
  assert.match(html, /pendingTimerStopOperationId/);
});
