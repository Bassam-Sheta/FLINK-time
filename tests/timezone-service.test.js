'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function loadService(timezone, weekStarts = 'Sunday', workspaceWeekStarts = '') {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  };
  global.MasterRepository = {
    getWorkspace() {
      return { WorkspaceID: 'W1', Timezone: timezone };
    },
    getGlobalSetting(key, fallback) {
      if (key === 'WS_W1_WEEK_STARTS') return workspaceWeekStarts || fallback;
      if (key === 'WEEK_STARTS') return weekStarts;
      if (key === 'DEFAULT_TIMEZONE') return timezone;
      return fallback;
    }
  };
  delete global.Utilities;
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).TimezoneService;
}

test('Cairo business date follows workspace timezone instead of UTC date', () => {
  const TimezoneService = loadService('Africa/Cairo');
  const key = TimezoneService.formatDateKey('W1', '2026-09-26T22:30:00.000Z');
  assert.equal(key, '2026-09-27');
});

test('Cairo Sunday week boundary converts local midnight to correct UTC instant', () => {
  const TimezoneService = loadService('Africa/Cairo', 'Sunday');
  const bounds = TimezoneService.getWeekBounds('W1', '2026-09-27');

  assert.equal(bounds.startLocalDate, '2026-09-27');
  assert.equal(bounds.endLocalDate, '2026-10-03');
  assert.equal(bounds.startUtc.toISOString(), '2026-09-26T21:00:00.000Z');
  assert.equal(bounds.endUtc.toISOString(), '2026-10-03T20:59:59.999Z');
});

test('week interval honors DST transitions instead of assuming fixed 168 hours', () => {
  const TimezoneService = loadService('America/New_York', 'Sunday');
  const bounds = TimezoneService.getWeekBounds('W1', '2026-11-01');
  const durationHours = (bounds.endUtc.getTime() + 1 - bounds.startUtc.getTime()) / 3600000;

  assert.equal(bounds.startLocalDate, '2026-11-01');
  assert.equal(bounds.endLocalDate, '2026-11-07');
  assert.equal(durationHours, 169);
});

test('configured Monday week start is honored', () => {
  const TimezoneService = loadService('UTC', 'Monday');
  const bounds = TimezoneService.getWeekBounds('W1', '2026-09-27');

  assert.equal(bounds.startLocalDate, '2026-09-21');
  assert.equal(bounds.endLocalDate, '2026-09-27');
  assert.deepEqual(bounds.dayLabels, [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
  ]);
});


test('workspace-specific week start overrides global week start', () => {
  const TimezoneService = loadService('UTC', 'Sunday', 'Monday');
  const bounds = TimezoneService.getWeekBounds('W1', '2026-09-27');

  assert.equal(bounds.startLocalDate, '2026-09-21');
  assert.equal(bounds.endLocalDate, '2026-09-27');
  assert.deepEqual(bounds.dayLabels, [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
  ]);
});

test('invalid configured week start fails closed instead of silently assuming Sunday', () => {
  const TimezoneService = loadService('UTC', 'Funday');
  assert.throws(
    () => TimezoneService.getWeekBounds('W1', '2026-09-27'),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      /Invalid week start/.test(err.message)
  );
});

test('invalid IANA workspace timezone returns controlled validation error', () => {
  const TimezoneService = loadService('Mars/Olympus_Mons');
  assert.throws(
    () => TimezoneService.formatDateKey('W1', '2026-09-28T00:00:00.000Z'),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      /Invalid IANA timezone/.test(err.message)
  );
});

test('formatDateTime includes explicit workspace timezone', () => {
  const TimezoneService = loadService('Africa/Cairo');
  const formatted = TimezoneService.formatDateTime(
    'W1',
    '2026-09-26T22:30:00.000Z'
  );
  assert.match(formatted, /Africa\/Cairo$/);
  assert.match(formatted, /^2026-09-27/);
});
