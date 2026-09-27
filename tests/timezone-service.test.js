'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/TimezoneService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function loadService(timezone, weekStarts = 'Sunday') {
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
