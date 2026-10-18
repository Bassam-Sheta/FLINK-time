'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { view, VIEWS } = require('./helpers/portal-fixture');

const html = view('user');

test('web timer sends operationId on start and timerId on stop', () => {
  assert.match(html, /apiCall\('timer\.start',[\s\S]{0,500}operationId/);
  assert.match(html, /apiCall\('timer\.stop',[\s\S]{0,300}timerId:\s*state\.activeTimer\.timerId/);
  assert.match(html, /pendingTimerStartOperationId/);
  assert.match(html, /pendingTimerStopOperationId/);
});

test('all three browser portals bind visibilitychange to restore active timer clock on tab focus', () => {
  for (const portal of VIEWS) {
    const portalHtml = view(portal);
    assert.match(
      portalHtml,
      /document\.addEventListener\(['"]visibilitychange['"]/,
      `${portal} must register a visibilitychange listener`
    );
    assert.match(
      portalHtml,
      /_updateLocalClock/,
      `${portal} must maintain an immediate clock update callback for visibility resumption`
    );
  }
});

test('all three browser portals bind pagehide to clean up running timer interval on page unload', () => {
  for (const portal of VIEWS) {
    const portalHtml = view(portal);
    assert.match(
      portalHtml,
      /window\.addEventListener\(['"]pagehide['"]/,
      `${portal} must register a pagehide listener`
    );
    assert.match(
      portalHtml,
      /clearInterval\(state\.timerInterval\)/,
      `${portal} must clear timerInterval on pagehide`
    );
  }
});

