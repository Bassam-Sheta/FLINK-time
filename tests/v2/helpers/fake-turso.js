'use strict';

/**
 * A local stand-in for Turso's HTTP pipeline API (BUILD_SPEC sections 5.2 and 10), built on node:sqlite.
 *
 *   const turso = createFakeTurso();        // fresh in-memory database
 *   turso.db.exec('CREATE TABLE ...');       // seed or inspect with the DatabaseSync handle
 *   const origin = turso.attach(fakes);      // UrlFetchApp.fetch(origin + '/v2/pipeline', ...) now reaches it
 *   turso.run([{ type: 'execute', stmt: { sql: 'SELECT 1' } }, { type: 'close' }]);   // direct, for tests
 *
 * What it implements: `execute`, `batch` with conditions (ok, error, not, and, or, is_autocommit) and `close`;
 * integers as decimal strings; per-step errors as { message }; a rollback of any transaction still open when a
 * pipeline ends (no batons, so every call is its own stream); and read-only tokens.
 *
 * Provisional behaviour: that an error in one request does not stop the pipeline, that a skipped step counts as
 * neither "ok" nor "error", and the exact wording of errors are what the spec expects of Turso. They are confirmed
 * only when Phase 0 tests 2, 3, 4 and 6 are recorded in docs/v2/phase0-results.md. rows_read and rows_written are
 * approximations (rows returned, rows changed); the real counters also count index rows.
 *
 * The binding trap (spec section 10, verified): node:sqlite binds every plain JS number as REAL, so
 * `(? - started_at) / 1000` would be float division and the duration_s CHECK would fail. Turso receives
 * {"type":"integer"} and does integer maths, so integer arguments are bound as BigInt, float arguments as
 * numbers, and statements read integers back as BigInt.
 */

const { DatabaseSync } = require('node:sqlite');

const TOKENS = Object.freeze({ rw: 'test-rw', ro: 'test-ro' });
const DEFAULT_ORIGIN = 'https://fake-db.turso.test';

// A malformed request: the whole request fails (request-level error).
class BadRequest extends Error {
  constructor(message) { super(message); this.code = 'BAD_REQUEST'; }
}
// A statement that could not run: inside a batch this is a step error, outside it is a request error.
class StepError extends Error {
  constructor(message) { super(message); this.code = 'SQLITE_ERROR'; }
}

// ---------------------------------------------------------------- values

function decodeArg(arg) {
  const type = arg !== null && typeof arg === 'object' ? arg.type : undefined;
  switch (type) {
    case 'null':
      return null;
    case 'integer':
      if (typeof arg.value !== 'string' || !/^-?\d+$/.test(arg.value)) {
        throw new BadRequest('integer value must be a decimal string');
      }
      return BigInt(arg.value);
    case 'float':
      if (typeof arg.value !== 'number') throw new BadRequest('float value must be a number');
      return arg.value;
    case 'text':
      if (typeof arg.value !== 'string') throw new BadRequest('text value must be a string');
      return arg.value;
    case 'blob':
      if (typeof arg.base64 !== 'string') throw new BadRequest('blob base64 must be a string');
      return Buffer.from(arg.base64, 'base64');
    default:
      throw new BadRequest('unknown argument type ' + JSON.stringify(type));
  }
}

function encodeValue(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') return { type: 'float', value };
  if (typeof value === 'string') return { type: 'text', value };
  if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  throw new Error('fake-turso: cannot encode ' + typeof value);
}

// ---------------------------------------------------------------- SQL text helpers

// Leading keyword of a statement, upper-cased, after whitespace and comments.
function firstKeyword(sql) {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      break;
    }
  }
  const match = /^[A-Za-z]+/.exec(sql.slice(i));
  return match ? match[0].toUpperCase() : '';
}

// True when anything but whitespace and comments follows a ';' outside quotes and comments.
// node:sqlite silently ignores everything after the first statement, so the fake refuses it instead.
function hasSecondStatement(sql) {
  let i = 0;
  let afterSemicolon = false;
  while (i < sql.length) {
    const c = sql[i];
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (afterSemicolon) {
      return true;
    } else if (c === ';') {
      afterSemicolon = true;
      i += 1;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const closer = c === '[' ? ']' : c;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === closer) {
          if (closer !== ']' && sql[i + 1] === closer) { i += 2; continue; }   // doubled quote
          break;
        }
        i += 1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the fake

function createFakeTurso(options = {}) {
  const origin = options.origin || DEFAULT_ORIGIN;
  // node:sqlite enforces foreign keys unless told not to. Whether Turso does is Phase 0 test 5, and the spec says code
  // must not depend on it (existence is checked by assert steps). So the default is OFF, which makes the asserts do
  // the work in tests; pass { foreignKeys: true } to see the other behaviour.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: options.foreignKeys === true });
  const injected = [];

  function executeStatement(spec, role) {
    if (spec === null || typeof spec !== 'object' || typeof spec.sql !== 'string') {
      throw new BadRequest('stmt.sql must be a string');
    }
    if (Array.isArray(spec.named_args) && spec.named_args.length > 0) {
      throw new BadRequest('named_args are not supported by fake-turso');
    }
    const args = (spec.args || []).map(decodeArg);
    const wantRows = spec.want_rows !== false;

    if (hasSecondStatement(spec.sql)) throw new StepError('a statement must contain exactly one SQL statement');
    // The read-only token may only SELECT or WITH ... SELECT. The keyword check refuses everything else up front;
    // query_only (set for the whole pipeline) makes SQLite itself refuse a WITH ... INSERT.
    // Real Turso's wording for a refused write is not recorded (Phase 0 test 6); this is SQLite's own.
    const keyword = firstKeyword(spec.sql);
    if (role === 'ro' && keyword !== 'SELECT' && keyword !== 'WITH') {
      throw new StepError('attempt to write a readonly database');
    }
    // Test-controlled failures (injectError): the statement fails before it runs, with the given message.
    const rule = injected.find(candidate => candidate.times > 0 && candidate.matches(spec.sql));
    if (rule) {
      rule.times -= 1;
      throw new StepError(rule.message);
    }

    try {
      const prepared = db.prepare(spec.sql);
      prepared.setReadBigInts(true);
      prepared.setReturnArrays(true);
      const columns = prepared.columns();

      let rows = [];
      let affected = 0;
      let lastInsertRowid = null;
      if (columns.length > 0) {
        rows = prepared.all(...args);      // statements with RETURNING report affected_row_count 0 here
      } else {
        const info = prepared.run(...args);
        affected = Number(info.changes);
        if (keyword === 'INSERT' || keyword === 'REPLACE') lastInsertRowid = String(info.lastInsertRowid);
      }
      return {
        cols: columns.map(column => ({ name: column.name, decltype: column.type })),
        rows: wantRows ? rows.map(row => row.map(encodeValue)) : [],
        affected_row_count: affected,
        last_insert_rowid: lastInsertRowid,
        rows_read: rows.length + affected,
        rows_written: affected,
      };
    } catch (err) {
      throw new StepError(err.message);
    }
  }

  function evaluate(condition, outcomes, index) {
    if (condition === undefined || condition === null) return true;
    switch (condition.type) {
      case 'ok':
      case 'error': {
        if (!Number.isInteger(condition.step) || condition.step < 0 || condition.step >= index) {
          throw new BadRequest(`condition refers to step ${condition.step}, which has not run yet`);
        }
        return outcomes[condition.step] === condition.type;
      }
      case 'not':
        return !evaluate(condition.cond, outcomes, index);
      case 'and':
        return condition.conds.every(c => evaluate(c, outcomes, index));
      case 'or':
        return condition.conds.some(c => evaluate(c, outcomes, index));
      case 'is_autocommit':
        return !db.isTransaction;
      default:
        throw new BadRequest('unknown condition type ' + JSON.stringify(condition.type));
    }
  }

  function runBatch(batch, role) {
    if (batch === null || typeof batch !== 'object' || !Array.isArray(batch.steps)) {
      throw new BadRequest('batch.steps must be an array');
    }
    const outcomes = [];
    const stepResults = [];
    const stepErrors = [];
    batch.steps.forEach((step, index) => {
      if (!evaluate(step.condition, outcomes, index)) {
        outcomes.push('skipped');
        stepResults.push(null);
        stepErrors.push(null);
        return;
      }
      try {
        stepResults.push(executeStatement(step.stmt, role));
        stepErrors.push(null);
        outcomes.push('ok');
      } catch (err) {
        if (!(err instanceof StepError)) throw err;
        stepResults.push(null);
        stepErrors.push({ message: err.message });
        outcomes.push('error');
      }
    });
    return { step_results: stepResults, step_errors: stepErrors };
  }

  function rollbackIfOpen() {
    if (db.isTransaction) db.exec('ROLLBACK');
  }

  function runRequest(request, role) {
    switch (request && request.type) {
      case 'execute':
        return { type: 'execute', result: executeStatement(request.stmt, role) };
      case 'batch':
        return { type: 'batch', result: runBatch(request.batch, role) };
      case 'close':
        rollbackIfOpen();
        return { type: 'close' };
      default:
        throw new BadRequest(`unsupported request type ${JSON.stringify(request && request.type)}`);
    }
  }

  function runPipeline(requests, role) {
    const results = [];
    let closed = false;
    if (role === 'ro') db.exec('PRAGMA query_only = ON');
    try {
      for (const request of requests) {
        if (closed) {
          results.push({ type: 'error', error: { message: 'the stream is closed', code: 'STREAM_CLOSED' } });
          continue;
        }
        try {
          results.push({ type: 'ok', response: runRequest(request, role) });
          if (request.type === 'close') closed = true;
        } catch (err) {
          if (!(err instanceof BadRequest) && !(err instanceof StepError)) throw err;
          results.push({ type: 'error', error: { message: err.message, code: err.code } });
        }
      }
    } finally {
      // No baton: this call was its own stream, so anything uncommitted is rolled back.
      rollbackIfOpen();
      if (role === 'ro') db.exec('PRAGMA query_only = OFF');
    }
    return { baton: null, base_url: null, results };
  }

  const roleOf = token => (token === TOKENS.rw ? 'rw' : token === TOKENS.ro ? 'ro' : null);

  // The HTTP layer without the HTTP: returns { status, json }.
  function handleBody(token, body) {
    const role = roleOf(token);
    if (role === null) return { status: 401, json: { error: 'The JWT is invalid' } };
    if (body === null || typeof body !== 'object' || !Array.isArray(body.requests)) {
      return { status: 400, json: { error: 'body must be an object with a "requests" array' } };
    }
    if (body.baton !== undefined && body.baton !== null) {
      return { status: 400, json: { error: 'fake-turso does not support batons; every call is its own stream' } };
    }
    return { status: 200, json: runPipeline(body.requests, role) };
  }

  // What the UrlFetchApp route receives: { url, method, headers, payload }.
  function handleHttp(request) {
    if (request.url !== origin + '/v2/pipeline') return { status: 404, body: '{"error":"not found"}' };
    if (request.method !== 'POST') return { status: 405, body: '{"error":"method not allowed"}' };
    const header = Object.keys(request.headers).find(name => name.toLowerCase() === 'authorization');
    const match = header ? /^Bearer (.+)$/.exec(request.headers[header]) : null;
    let body;
    try { body = JSON.parse(request.payload); } catch (err) {
      return { status: match && roleOf(match[1]) ? 400 : 401, body: '{"error":"invalid JSON body"}' };
    }
    const { status, json } = handleBody(match ? match[1] : '', body);
    return { status, body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } };
  }

  return {
    db,
    origin,
    tokens: TOKENS,
    handleBody,
    // The UrlFetchApp route itself, for tests that wrap it (drop the response, delay it, fail the Nth call).
    handleHttp,
    // Direct call for tests; throws if the HTTP layer refused it.
    run(requests, token = TOKENS.rw) {
      const { status, json } = handleBody(token, { requests });
      if (status !== 200) throw new Error(`fake-turso refused the call: ${status} ${JSON.stringify(json)}`);
      return json;
    },
    // Makes the next `times` statements whose SQL matches (a RegExp, or a substring) fail with `message` instead of
    // running, e.g. injectError({ match: 'BEGIN IMMEDIATE', message: 'database is locked' }) to produce BUSY.
    injectError({ match, message, times = 1 }) {
      const matches = match instanceof RegExp ? sql => match.test(sql) : sql => sql.includes(match);
      injected.push({ matches, message, times });
    },
    // Makes UrlFetchApp.fetch(origin + '/v2/pipeline') reach this database.
    attach(fakes) {
      fakes.fetch.route(origin + '/', handleHttp);
      return origin;
    },
    close() { db.close(); },
  };
}

module.exports = { createFakeTurso, TOKENS, DEFAULT_ORIGIN };
