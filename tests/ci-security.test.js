'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.resolve(
  __dirname,
  '../.github/workflows/stabilization-tests.yml'
);

test('GitHub Actions dependencies are pinned to immutable commit SHAs', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)]
    .map(match => match[1]);

  assert.ok(uses.length >= 5);
  for (const action of uses) {
    const ref = action.split('@')[1] || '';
    assert.match(
      ref,
      /^[0-9a-f]{40}$/,
      `Action is not SHA-pinned: ${action}`
    );
  }
});

test('CI contains a high-severity dependency advisory gate', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /npm audit --audit-level=high/);
});
