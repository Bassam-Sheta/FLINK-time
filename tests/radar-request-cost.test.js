'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { radarSheetFixture } = require('./helpers/radar-sheet-fixture');

test('self radar transfers only three matching rows at 10 and 50,000 records per table', () => {
  const small = radarSheetFixture(10).run();
  const large = radarSheetFixture(50000).run();
  for (const measurement of [small, large]) {
    assert.equal(measurement.result.activeCount, 1);
    assert.equal(measurement.result.workers[0].userName, 'Synthetic User');
    assert.equal(measurement.result.workers[0].projectName, 'Synthetic Project');
    assert.equal(measurement.calls.byMethod.getDataRange || 0, 0);
    assert.equal(measurement.calls.byMethod.getValues, 3);
    assert.ok(measurement.cells < 100);
  }
  assert.deepEqual(large.calls, small.calls);
  assert.equal(large.cells, small.cells);
});

test('idle self radar transfers zero cells and skips both metadata tables', () => {
  const measurement = radarSheetFixture(50000, { idle: true }).run();
  assert.equal(measurement.result.activeCount, 0);
  assert.equal(measurement.cells, 0);
  assert.equal(measurement.calls.byMethod.getSheetByName, 1);
});
