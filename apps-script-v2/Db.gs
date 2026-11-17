/**
 * Db.gs - Turso HTTP client and transaction builder (BUILD_SPEC sections 5.2 and 5.3).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 *   Db.read_(statements, opts)   reads in one call; opts.token 'ro' (default) or 'rw'
 *   Db.tx_(ctx)                  a write transaction builder; every write in the app goes through it
 *
 * Every call is one POST to {TURSO_URL}/v2/pipeline: a "batch" request and a trailing "close", so Turso rolls back
 * anything left uncommitted. Failures are thrown as AppError_ with the codes of section 4.3 and never carry the token.
 *
 * Facts about Turso that this file relies on are provisional until Phase 0 records them in
 * docs/v2/phase0-results.md: that a step whose condition is false is skipped, that a skipped step counts as "not ok",
 * that a failed step leaves the transaction open for the ROLLBACK step, and the wording of error messages.
 */
var Db = {

  /** Writes per user per minute when the caller does not pass ctx.rateLimit (the RATE_LIMIT_WRITES_PER_MIN default). */
  RATE_LIMIT_DEFAULT_: 60,

  /** Columns of audit_log that a caller supplies, in insert order. The rest are filled in by the sealer. */
  AUDIT_COLUMNS_: ['ts', 'actor_user_id', 'actor_role', 'workspace_id', 'entity_type', 'entity_id', 'action',
    'before_json', 'after_json', 'reason', 'request_id'],
  AUDIT_REQUIRED_: ['ts', 'actor_user_id', 'actor_role', 'entity_type', 'entity_id', 'action', 'request_id'],

  /** What SQLite and Turso say when another writer holds the database. */
  BUSY_PATTERN_: /SQLITE_BUSY|database is locked/i,

  // ------------------------------------------------------------ errors

  /** A mistake in the calling code, or a response this client cannot use. The message is generic; details are logged. */
  bug_: function (detail) {
    return new AppError_('INTERNAL', 'The database request could not be completed.', { error: detail });
  },

  unavailable_: function (details) {
    return new AppError_('DB_UNAVAILABLE', 'The database is not reachable right now; try again.', details);
  },

  busy_: function () {
    return new AppError_('BUSY', 'The database is busy; try again.');
  },

  isBusy_: function (message) {
    return Db.BUSY_PATTERN_.test(String(message));
  },

  /** What a failed statement outside a write transaction means: BUSY, or INTERNAL with the SQL error in details. */
  statementFailure_: function (message) {
    if (Db.isBusy_(message)) return Db.busy_();
    return new AppError_('INTERNAL', 'The database rejected a statement.', { error: String(message) });
  },

  // ------------------------------------------------------------ values

  /** Hrana argument for a JavaScript value (BUILD_SPEC section 5.2). Anything that is not listed there throws. */
  arg_: function (value) {
    if (value === null || value === undefined) return { type: 'null' };
    if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value)) return { type: 'integer', value: String(value) };
      if (Number.isFinite(value)) return { type: 'float', value: value };
      throw Db.bug_('a SQL argument is not a finite number');
    }
    if (typeof value === 'string') return { type: 'text', value: value };
    throw Db.bug_('unsupported SQL argument type ' + typeof value);
  },

  /** Plain JavaScript value of one typed Hrana cell. Integers must be safe integers; blobs are refused. */
  value_: function (cell) {
    switch (cell.type) {
      case 'null':
        return null;
      case 'integer': {
        var number = Number(cell.value);
        if (!Number.isSafeInteger(number)) throw Db.bug_('integer outside the safe range: ' + cell.value);
        return number;
      }
      case 'float':
      case 'text':
        return cell.value;
      case 'blob':
        throw Db.bug_('blob values are not supported');
      default:
        throw Db.bug_('unknown value type ' + cell.type);
    }
  },

  /** The rows of one step result as objects keyed by column name. */
  rows_: function (result) {
    var names = result.cols.map(function (column) { return column.name; });
    return result.rows.map(function (row) {
      var object = {};
      names.forEach(function (name, index) { object[name] = Db.value_(row[index]); });
      return object;
    });
  },

  /** A Hrana statement from SQL text and a JavaScript argument array. */
  stmt_: function (sql, args) {
    if (typeof sql !== 'string' || sql.trim() === '') throw Db.bug_('a statement needs SQL text');
    if (args !== undefined && !Array.isArray(args)) throw Db.bug_('statement arguments must be an array');
    return { sql: sql, args: (args || []).map(function (value) { return Db.arg_(value); }) };
  },

  // ------------------------------------------------------------ transport

  /** Address and token from Script Properties. kind is 'ro' or 'rw'. */
  config_: function (kind) {
    var properties = PropertiesService.getScriptProperties();
    var tokenName = kind === 'rw' ? 'TURSO_RW_TOKEN' : 'TURSO_RO_TOKEN';
    var url = properties.getProperty('TURSO_URL');
    var token = properties.getProperty(tokenName);
    if (!url) throw Db.bug_('TURSO_URL is not set');
    if (!token) throw Db.bug_(tokenName + ' is not set');
    return { url: String(url).replace(/\/+$/, ''), token: token };
  },

  /**
   * Adds this call's rows_read, rows_written and one call to the day's counter in the cache, keyed by UTC date. The
   * health job copies it into job_runs. A lost update only makes the numbers a little low, and a cache failure must
   * never fail a database call.
   */
  recordUsage_: function (results) {
    try {
      var read = 0;
      var written = 0;
      var add = function (result) {
        if (!result) return;
        read += result.rows_read || 0;
        written += result.rows_written || 0;
      };
      results.forEach(function (item) {
        if (item.type !== 'ok' || !item.response) return;
        if (item.response.type === 'execute') add(item.response.result);
        if (item.response.type === 'batch') item.response.result.step_results.forEach(add);
      });
      var key = 'usage:' + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
      var cache = CacheService.getScriptCache();
      var total = { read: 0, written: 0, calls: 0 };
      try {
        var raw = cache.get(key);
        if (raw) total = JSON.parse(raw);
      } catch (err) {
        total = { read: 0, written: 0, calls: 0 };
      }
      total.read += read;
      total.written += written;
      total.calls += 1;
      cache.put(key, JSON.stringify(total), 21600);
    } catch (err) {
      // deliberately ignored
    }
  },

  /**
   * One pipeline call carrying a batch of steps. Returns { step_results, step_errors }. Anything that stops us
   * from knowing what happened (fetch failure, non-200, unreadable or unexpected response, a request-level error) is
   * DB_UNAVAILABLE, because the outcome is unknown and the page retries with the same request id.
   */
  batch_: function (kind, steps) {
    var conn = Db.config_(kind);
    var response;
    try {
      response = UrlFetchApp.fetch(conn.url + '/v2/pipeline', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + conn.token },
        payload: JSON.stringify({ requests: [{ type: 'batch', batch: { steps: steps } }, { type: 'close' }] }),
        muteHttpExceptions: true
      });
    } catch (err) {
      throw Db.unavailable_({ reason: 'fetch failed', error: String(err && err.message) });
    }
    var status = response.getResponseCode();
    if (status !== 200) throw Db.unavailable_({ status: status });

    var parsed;
    try {
      parsed = JSON.parse(response.getContentText());
    } catch (err) {
      throw Db.unavailable_({ reason: 'unreadable response' });
    }
    if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
      throw Db.unavailable_({ reason: 'unexpected response shape' });
    }
    Db.recordUsage_(parsed.results);

    var first = parsed.results[0];
    if (first.type === 'error') {
      var message = first.error && first.error.message;
      if (Db.isBusy_(message)) throw Db.busy_();
      throw Db.unavailable_({ reason: 'request error', error: String(message) });
    }
    var outcome = first.response && first.response.type === 'batch' ? first.response.result : null;
    if (!outcome || !Array.isArray(outcome.step_results) || !Array.isArray(outcome.step_errors) ||
        outcome.step_results.length !== steps.length || outcome.step_errors.length !== steps.length) {
      throw Db.unavailable_({ reason: 'unexpected response shape' });
    }
    return outcome;
  },

  /** Index of the first step with an error, or -1. */
  firstError_: function (outcome) {
    for (var i = 0; i < outcome.step_errors.length; i++) {
      if (outcome.step_errors[i] !== null) return i;
    }
    return -1;
  },

  // ------------------------------------------------------------ reads

  /**
   * statements: [{ sql, args }]. Returns one array of row objects per statement. One pipeline, one batch with no
   * BEGIN and no conditions. opts.token: 'ro' (default) or 'rw'.
   */
  read_: function (statements, opts) {
    var kind = (opts && opts.token) || 'ro';
    if (kind !== 'ro' && kind !== 'rw') throw Db.bug_('Db.read_ token must be "ro" or "rw"');
    if (!Array.isArray(statements)) throw Db.bug_('Db.read_ needs an array of statements');
    if (statements.length === 0) return [];

    var steps = statements.map(function (statement) {
      return { stmt: Db.stmt_(statement.sql, statement.args) };
    });
    var outcome = Db.batch_(kind, steps);
    var failed = Db.firstError_(outcome);
    if (failed >= 0) throw Db.statementFailure_(outcome.step_errors[failed].message);
    return outcome.step_results.map(function (result) { return Db.rows_(result); });
  },

  // ------------------------------------------------------------ writes

  /** Checks the pieces of the context that Db.tx_ uses and returns the rate limit to apply. */
  checkContext_: function (ctx) {
    if (!ctx || typeof ctx !== 'object') throw Db.bug_('Db.tx_ needs a context');
    ['userId', 'requestId', 'action', 'payloadHash'].forEach(function (name) {
      if (typeof ctx[name] !== 'string' || ctx[name] === '') throw Db.bug_('context.' + name + ' must be a non-empty string');
    });
    if (!Number.isSafeInteger(ctx.now)) throw Db.bug_('context.now must be an integer number of milliseconds');
    if (ctx.rateLimit === undefined) return Db.RATE_LIMIT_DEFAULT_;
    if (!Number.isSafeInteger(ctx.rateLimit) || ctx.rateLimit < 1) throw Db.bug_('context.rateLimit must be a positive integer');
    return ctx.rateLimit;
  },

  /** Validates an { code, message, details? } given for a failing step. */
  errorSpec_: function (spec, what) {
    if (!spec || !Object.prototype.hasOwnProperty.call(ERROR_CODES_, spec.code) || typeof spec.message !== 'string') {
      throw Db.bug_(what + ' needs a known error code and a message');
    }
    return { code: spec.code, message: spec.message, details: spec.details };
  },

  /**
   * The request id was seen before. Same action and payload hash: it is the retry of a request that already
   * committed, so return what it stored. Anything else is a reused id.
   */
  duplicate_: function (ctx) {
    var found = Db.read_([{
      sql: 'SELECT action, payload_sha256, result_json FROM request_log WHERE user_id = ? AND request_id = ?',
      args: [ctx.userId, ctx.requestId]
    }], { token: 'rw' })[0];
    if (found.length === 0) throw Db.bug_('request_log reported a duplicate but holds no such row');
    var row = found[0];
    if (row.action === ctx.action && row.payload_sha256 === ctx.payloadHash) {
      var stored;
      try {
        stored = JSON.parse(row.result_json);
      } catch (err) {
        throw Db.bug_('the stored result of a request is not valid JSON');
      }
      return { duplicate: true, result: stored };
    }
    throw new AppError_('VALIDATION', 'This request id was already used for a different request.', { field: 'requestId' });
  },

  /** Turns the first failed step of a write transaction into a thrown AppError_, or returns the duplicate outcome. */
  failure_: function (ctx, step, message) {
    if (step.kind === 'begin' || Db.isBusy_(message)) throw Db.busy_();
    switch (step.kind) {
      case 'request_log':
        if (/UNIQUE constraint failed/.test(message)) return Db.duplicate_(ctx);
        break;
      case 'rate':
        throw new AppError_('RATE_LIMITED', 'Too many changes in a minute; wait a moment and try again.');
      case 'assert':
        throw new AppError_(step.error.code, step.error.message, step.error.details);
      case 'exec':
        if (step.error) throw new AppError_(step.error.code, step.error.message, step.error.details);
        if (/UNIQUE constraint failed/.test(message)) {
          throw new AppError_('CONFLICT', 'This conflicts with an existing record; reload and try again.');
        }
        break;
      default:
        break;
    }
    throw new AppError_('INTERNAL', 'The database rejected a statement.', { step: step.label || step.kind, error: String(message) });
  },

  /**
   * A write transaction. ctx = { userId, requestId, action, payloadHash, now, rateLimit? } (BUILD_SPEC section 5.3).
   * Add steps with assert, exec, select and audit, set the stored response with result, then commit once. Every step
   * is checked and every argument encoded when it is added, so a mistake surfaces at the line that made it.
   *
   * commit() sends ONE call: BEGIN IMMEDIATE, the request_log insert, the rate-limit assert (not for SYSTEM), the caller's
   * steps in order, the audit inserts, COMMIT, and a ROLLBACK that runs only if COMMIT did not succeed. Each step
   * runs only if the step before it succeeded. It returns { ok: true, selects: { label: rows } }, or
   * { duplicate: true, result } when this request id already committed, or throws AppError_.
   */
  tx_: function (ctx) {
    var rateLimit = Db.checkContext_(ctx);
    var steps = [];          // caller steps in order: { kind, label, stmt, error? }
    var audits = [];
    var labels = {};
    var resultJson = '{}';
    var finished = false;
    var builder = {};

    var open = function () {
      if (finished) throw Db.bug_('this transaction was already committed');
    };
    var claim = function (label) {
      if (typeof label !== 'string' || label === '') throw Db.bug_('a step needs a label');
      if (labels[label]) throw Db.bug_('step label used twice: ' + label);
      labels[label] = true;
    };

    // INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT (<condition>): the step fails exactly when the
    // condition is false, with a NOT NULL error on _assert.
    builder.assert = function (label, conditionSql, args, code, message, details) {
      open();
      claim(label);
      if (typeof conditionSql !== 'string' || conditionSql.trim() === '') throw Db.bug_('an assert needs a condition');
      var error = Db.errorSpec_({ code: code, message: message, details: details }, 'assert ' + label);
      steps.push({
        kind: 'assert', label: label, error: error,
        stmt: Db.stmt_('INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT (' + conditionSql + ')', args)
      });
      return builder;
    };

    builder.exec = function (label, sql, args, onError) {
      open();
      claim(label);
      var error = onError === undefined ? null : Db.errorSpec_(onError, 'exec ' + label);
      steps.push({ kind: 'exec', label: label, error: error, stmt: Db.stmt_(sql, args) });
      return builder;
    };

    builder.select = function (label, sql, args) {
      open();
      claim(label);
      steps.push({ kind: 'select', label: label, stmt: Db.stmt_(sql, args) });
      return builder;
    };

    builder.audit = function (row) {
      open();
      if (!row || typeof row !== 'object') throw Db.bug_('an audit row must be an object');
      Object.keys(row).forEach(function (key) {
        if (Db.AUDIT_COLUMNS_.indexOf(key) < 0) throw Db.bug_('unknown audit field ' + key);
      });
      Db.AUDIT_REQUIRED_.forEach(function (key) {
        if (row[key] === undefined || row[key] === null) throw Db.bug_('audit field ' + key + ' is required');
      });
      var values = Db.AUDIT_COLUMNS_.map(function (key) { return row[key] === undefined ? null : row[key]; });
      var marks = Db.AUDIT_COLUMNS_.map(function () { return '?'; }).join(', ');
      audits.push({
        kind: 'audit', label: 'audit',
        stmt: Db.stmt_('INSERT INTO audit_log (' + Db.AUDIT_COLUMNS_.join(', ') + ') VALUES (' + marks + ')', values)
      });
      return builder;
    };

    // The response data stored in request_log.result_json. It must be known before the call, so handlers create
    // every id and timestamp in Apps Script. Not hashed, so plain JSON.stringify is enough here.
    builder.result = function (data) {
      open();
      var json;
      try {
        json = JSON.stringify(data);
      } catch (err) {
        throw Db.bug_('the result is not JSON');
      }
      if (typeof json !== 'string') throw Db.bug_('the result is not JSON');
      resultJson = json;
      return builder;
    };

    builder.commit = function () {
      open();
      finished = true;

      var sent = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }];
      var plan = [{ kind: 'begin' }];
      var add = function (info, stmt) {
        sent.push({ condition: { type: 'ok', step: sent.length - 1 }, stmt: stmt });
        plan.push(info);
      };

      add({ kind: 'request_log' }, Db.stmt_(
        'INSERT INTO request_log (user_id, request_id, action, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [ctx.userId, ctx.requestId, ctx.action, ctx.payloadHash, resultJson, ctx.now]));
      if (ctx.userId !== 'SYSTEM') {
        add({ kind: 'rate' }, Db.stmt_(
          'INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT ((SELECT COUNT(*) FROM request_log WHERE user_id = ? AND created_at > ?) <= ?)',
          [ctx.userId, ctx.now - 60000, rateLimit]));
      }
      steps.concat(audits).forEach(function (step) { add(step, step.stmt); });
      add({ kind: 'commit' }, { sql: 'COMMIT', args: [] });
      var commitIndex = sent.length - 1;
      sent.push({ condition: { type: 'not', cond: { type: 'ok', step: commitIndex } }, stmt: { sql: 'ROLLBACK', args: [] } });
      plan.push({ kind: 'rollback' });

      var outcome = Db.batch_('rw', sent);
      var failed = Db.firstError_(outcome);
      if (failed >= 0) return Db.failure_(ctx, plan[failed], outcome.step_errors[failed].message || '');
      if (outcome.step_results[commitIndex] === null) throw Db.bug_('COMMIT did not run');

      var selects = {};
      plan.forEach(function (step, index) {
        if (step.kind === 'select') selects[step.label] = Db.rows_(outcome.step_results[index]);
      });
      return { ok: true, selects: selects };
    };

    return builder;
  }
};
