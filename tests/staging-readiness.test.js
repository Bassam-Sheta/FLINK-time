'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readiness } = require('../scripts/staging');

test('readiness reports missing configuration without loading credentials or calling Google', () => {
  const result = readiness(null, {});
  assert.equal(result.readyForUpload, false);
  assert.equal(result.config, 'MISSING');
  assert.equal(result.googleContacted, false);
});

test('readiness redacts invalid config and does not claim live verification', () => {
  const result = readiness({ secret: 'DO-NOT-PRINT' }, { FLINK_STAGING_CREDENTIALS: 'DO-NOT-PRINT' });
  assert.equal(result.config, 'INVALID');
  assert.equal(JSON.stringify(result).includes('DO-NOT-PRINT'), false);
  assert.equal(result.liveVerified, false);
});
