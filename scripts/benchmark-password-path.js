'use strict';

// Offline synthetic comparison only. No credentials, Google calls or writes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { radarSheetFixture } = require('../tests/helpers/radar-sheet-fixture');
const root = path.resolve(__dirname, '..');
const baseline = process.argv[2] || 'd03ec60';
if (!/^[0-9a-f]{7,40}$/.test(baseline)) throw new Error('An immutable hexadecimal baseline revision is required.');

function atRevision(file) {
  return execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 4000000 });
}
const password = 'SyntheticPassword1!pepper';
const salt = '00112233445566778899aabbccddeeff';
const expected = crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256').toString('hex');
function kdf(source) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    let serviceCalls = 0;
    const context = vm.createContext({
      console,
      Utilities: { computeHmacSha256Signature(message, key) {
        serviceCalls++;
        return Array.from(crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255)))
          .update(Buffer.from(message.map(b => b & 255))).digest()).map(b => b > 127 ? b - 256 : b);
      } }
    });
    vm.runInContext(source, context);
    const start = performance.now();
    const actual = context.SecurityService.pbkdf2Sync(password, salt, 10000, 32);
    const elapsedMs = performance.now() - start;
    assert.equal(actual, expected);
    samples.push({ milliseconds: Number(elapsedMs.toFixed(2)), utilitiesCalls: serviceCalls });
  }
  const sorted = samples.map(run => run.milliseconds).sort((a,b) => a-b);
  return { iterations: 10000, bytes: 32, samples, medianMs: sorted[1], rangeMs: [sorted[0],sorted[2]] };
}

function measure(source, read, passwordKdf, deployableNames) {
  const radar = {};
  for (const rows of [10, 50000]) {
    const measurement = radarSheetFixture(rows, { source }).run();
    assert.equal(measurement.result.activeCount, 1);
    radar[rows] = { transferredCells: measurement.cells, calls: measurement.calls };
  }
  return {
    passwordKdf,
    selfRadar: radar,
    deployableUtf8Bytes: Object.fromEntries(deployableNames
      .map(name => [name, Buffer.byteLength(read('apps-script/' + name))]))
  };
}
const readCurrent = file => fs.readFileSync(path.join(root, file), 'utf8');
const beforeSource = atRevision('apps-script/Code.gs');
const afterSource = readCurrent('apps-script/Code.gs');
// The single-portal refactor changed the deployable file set, so each cohort is
// measured against the file names that existed at its own revision.
const beforeFiles = ['Code.gs', 'User.html', 'Admin.html', 'SuperAdmin.html'];
const afterFiles = ['Code.gs', 'Portal.html', 'appsscript.json'];
// Keep both timing cohorts cold and ahead of the large table allocations.
const beforePasswordKdf = kdf(beforeSource);
const afterPasswordKdf = kdf(afterSource);
const before = measure(beforeSource, atRevision, beforePasswordKdf, beforeFiles);
const after = measure(afterSource, readCurrent, afterPasswordKdf, afterFiles);
console.log(JSON.stringify({
  baseline, node: process.version, platform: process.platform,
  evidence: 'Fresh synthetic Node VM per sample; code loading untimed; Utilities simulated with Node crypto. Not Google latency or whole-app speed.',
  before, after, localKdfMedianSpeedup: Number((before.passwordKdf.medianMs / after.passwordKdf.medianMs).toFixed(2))
}, null, 2));
